#!/usr/bin/env node
/**
 * Alef Supervisor — agent broker with blue-green deployment.
 *
 * The supervisor is the single process owner. It never runs agent logic itself.
 * Instead it:
 *   - Spawns the "green" agent (interactive session) with an IPC channel
 *   - Receives spawn/kill/status requests from the green agent via IPC
 *   - Delegates agent spawning to AgentBroker
 *   - Handles /rebuild: build → blue-slot eval gate → promote → restart green
 *
 * Architecture:
 *   Supervisor (this file)
 *     ├── Green Agent (interactive, IPC channel on fd 3)
 *     ├── Subagent 1 (spawned by broker on green's request)
 *     ├── Subagent 2
 *     └── Blue Agent (eval gate, ephemeral)
 *
 * Usage:
 *   ./alef-dev.sh [alef args...]
 */

import { type ChildProcess, execSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentBroker } from "./broker/agent-broker.js";
import { isAgentToSupervisor, type UpdateScope } from "./broker/protocol.js";
import {
	createRuntimeHandoffEnvelope,
	markRuntimeHandoffAcked,
	markRuntimeHandoffFinalized,
	type RuntimeHandoffEnvelope,
	validateRuntimeHandoffEnvelope,
} from "./broker/runtime-handoff.js";
import { SupervisorLifecycleMachine, type SupervisorTransitionResult } from "./broker/supervisor-fsm.js";

const REBUILD_EXIT_CODE = 75;
const HANDOFF_STATE_PATH = [".alef", "supervisor-handoff.json"] as const;
const SUPERVISOR_PROBE_FLAG = "--probe";
const DIST_BACKUP_PREFIX = "alef-supervisor-dist-";
const ALLOW_UNVERIFIED_UPDATES_ENV = "ALEF_SUPERVISOR_ALLOW_UNVERIFIED_UPDATES";
const SEMVER_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

// Packages whose vitest suites are run as part of the blue-slot eval gate.
// Extend this list when new packages are added to the monorepo.
const EVAL_GATE_PACKAGES = [
	"packages/spine",
	"packages/corpus",
	"packages/organ-fs",
	"packages/organ-shell",
	"packages/organ-dialog",
	"packages/organ-lector",
	"packages/organ-llm",
	"packages/organ-enclosure",
	"packages/organ-router",
	"packages/testkit",
	"packages/eval",
	"packages/runner",
] as const;

const EVAL_CHECK_TIMEOUT = 180_000;
const EVAL_TEST_TIMEOUT = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
	let dir = resolve(import.meta.dirname ?? __dirname);
	for (let i = 0; i < 5; i++) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) {
			return dir;
		}
		dir = resolve(dir, "..");
	}
	throw new Error(`Could not find monorepo root from ${import.meta.dirname}`);
}

/**
 * Find the runner entry point (packages/runner) which supports --serve.
 * Returns undefined when the runner has not been built yet — health check
 * is then skipped gracefully.
 */
function findRunnerBin(repoRoot: string): string | undefined {
	const distPath = join(repoRoot, "packages", "runner", "dist", "main.js");
	if (existsSync(distPath)) return distPath;
	const srcPath = join(repoRoot, "packages", "runner", "src", "main.ts");
	if (existsSync(srcPath)) return srcPath;
	return undefined;
}

function findAlefBin(repoRoot: string): string {
	// cli.ts/cli.js is the real entry point — it sets up undici and calls main().
	// main.ts/main.js only exports main() and is not self-executing.
	const cliDistPath = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
	if (existsSync(cliDistPath)) return cliDistPath;
	const cliSrcPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
	if (existsSync(cliSrcPath)) return cliSrcPath;
	throw new Error("Could not find Alef entry point (cli.js / cli.ts)");
}

/**
 * Build the argument list for spawning a new supervisor instance.
 *
 * tsx patches process.argv[1] to the TypeScript source file and does not
 * add itself to argv. When the supervisor is running from source (`.ts`),
 * we must prepend the tsx CLI so Node.js can execute TypeScript.
 * In production (compiled `.js`), the entry is already executable by Node.
 */
export function buildSupervisorSpawnArgs(baseArgs: string[]): string[] {
	const entry = process.argv[1] ?? "";
	if (entry.endsWith(".ts")) {
		// Running under tsx in development — find tsx relative to the repo root.
		let searchDir = dirname(entry);
		for (let i = 0; i < 6; i++) {
			const tsxCli = join(searchDir, "node_modules", "tsx", "dist", "cli.mjs");
			if (existsSync(tsxCli)) {
				return [tsxCli, entry, ...baseArgs];
			}
			const parent = dirname(searchDir);
			if (parent === searchDir) break;
			searchDir = parent;
		}
	}
	// Production compiled JS — Node can execute directly.
	return [entry, ...baseArgs];
}

export function parseSessionFromArgs(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--session" && i + 1 < args.length) {
			return args[i + 1];
		}
	}
	return undefined;
}

export function stripProbeFlag(args: string[]): string[] {
	return args.filter((arg) => arg !== SUPERVISOR_PROBE_FLAG);
}

export function hasProbeFlag(args: string[]): boolean {
	return args.includes(SUPERVISOR_PROBE_FLAG);
}

export function buildChildArgs(sessionFile: string | undefined, baseArgs: string[]): string[] {
	const args = [...baseArgs];
	if (sessionFile) {
		const hasSession = args.some((a, i) => a === "--session" && i + 1 < args.length);
		if (!hasSession) {
			args.unshift("--session", sessionFile);
		}
	}
	return args;
}

export function parseJsonArray(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}

export function parseUpdateScope(value: string | undefined): UpdateScope | undefined {
	if (value === "rebuild" || value === "packages" || value === "self") {
		return value;
	}
	return undefined;
}

export function getGreenInvocation(repoRoot: string, childArgs: string[]): { command: string; args: string[] } {
	const overrideScript = process.env.ALEF_SUPERVISOR_GREEN_SCRIPT?.trim();
	if (overrideScript) {
		const overrideArgs = parseJsonArray(process.env.ALEF_SUPERVISOR_GREEN_ARGS);
		return {
			command: process.execPath,
			args: [overrideScript, ...overrideArgs, ...childArgs],
		};
	}
	const alefBin = findAlefBin(repoRoot);
	const isTs = alefBin.endsWith(".ts");
	if (isTs) {
		return {
			command: "npx",
			args: ["tsx", alefBin, ...childArgs],
		};
	}
	return {
		command: "node",
		args: [alefBin, ...childArgs],
	};
}

// ---------------------------------------------------------------------------
// Blue-slot health check (process liveness via HTTP)
// ---------------------------------------------------------------------------

const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/**
 * Poll GET /health until it returns { ok: true } or the timeout expires.
 * Uses Node's built-in http — no external dependencies.
 */
async function pollHealth(url: string, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const ok = await new Promise<boolean>((resolve) => {
			http
				.get(url, (res) => {
					let body = "";
					res.on("data", (chunk: Buffer) => {
						body += chunk.toString();
					});
					res.on("end", () => {
						try {
							const json = JSON.parse(body) as Record<string, unknown>;
							resolve(json.ok === true);
						} catch {
							resolve(false);
						}
					});
				})
				.on("error", () => resolve(false));
		});
		if (ok) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

/**
 * runHealthCheck — spawns an ephemeral runner process with --serve 0,
 * waits for the router to bind, polls GET /health, then kills the process.
 *
 * Proves the new binary starts cleanly and the HTTP surface is responsive
 * before the eval gate runs static compile+test checks.
 *
 * Env overrides:
 *   ALEF_SUPERVISOR_TEST_HEALTH_RESULT=pass|fail  — force result (tests)
 *   ALEF_SUPERVISOR_SKIP_HEALTH=1                 — skip entirely (CI shortcut)
 */
async function runHealthCheck(repoRoot: string): Promise<{ passed: boolean; error?: string }> {
	const forced = process.env.ALEF_SUPERVISOR_TEST_HEALTH_RESULT;
	if (forced === "pass") return { passed: true };
	if (forced === "fail") return { passed: false, error: "forced fail" };
	if (process.env.ALEF_SUPERVISOR_SKIP_HEALTH === "1") return { passed: true };

	const runnerBin = findRunnerBin(repoRoot);
	if (!runnerBin) {
		console.log("[supervisor] Health check: runner binary not found, skipping.");
		return { passed: true };
	}

	return new Promise((resolve) => {
		let settled = false;
		let portFound = false;

		const isTs = runnerBin.endsWith(".ts");
		const cmd = isTs ? "npx" : "node";
		const cmdArgs = isTs ? ["tsx", runnerBin, "--serve", "0", "--no-tui"] : [runnerBin, "--serve", "0", "--no-tui"];

		const proc = spawn(cmd, cmdArgs, {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, ALEF_SUPERVISOR_BLUE: "1" },
		});

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill("SIGTERM");
				resolve({ passed: false, error: `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms` });
			}
		}, HEALTH_CHECK_TIMEOUT_MS);

		// The runner logs: [alef] router listening on http://<host>:<port>
		let stderrBuf = "";
		proc.stderr.on("data", (chunk: Buffer) => {
			if (portFound) return;
			stderrBuf += chunk.toString();
			const match = stderrBuf.match(/router listening on http:\/\/[\d.]+:(\d+)/);
			if (!match) return;
			portFound = true;
			const port = Number.parseInt(match[1], 10);
			void pollHealth(`http://127.0.0.1:${port}/health`, 10_000).then((ok) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					proc.kill("SIGTERM");
					resolve(ok ? { passed: true } : { passed: false, error: "GET /health did not return ok:true" });
				}
			});
		});

		proc.on("exit", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ passed: false, error: `Process exited (${code}) before router was ready` });
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Blue-slot eval gate
// ---------------------------------------------------------------------------

/**
 * runEvalGate — the assertion set for the blue-slot probe.
 *
 * Runs two checks against the repo:
 *   1. npm run check — type check + lint (biome + tsgo)
 *   2. vitest run per EVAL_GATE_PACKAGES — full unit/integration test suite
 *
 * Returns { passed, report } where report is a human-readable summary
 * suitable for feeding back to the agent on failure (TSK-77).
 */
async function runEvalGate(repoRoot: string): Promise<{ passed: boolean; report: string }> {
	// 1. Type check + lint.
	try {
		execSync("npm run check", {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: EVAL_CHECK_TIMEOUT,
		});
		console.log("[supervisor] Eval gate: check passed.");
	} catch (err) {
		const out = extractExecOutput(err);
		console.error("[supervisor] Eval gate: check failed.");
		return { passed: false, report: `check failed:\n${out}` };
	}

	// 2. Test suite — per package.
	for (const pkg of EVAL_GATE_PACKAGES) {
		const pkgDir = join(repoRoot, pkg);
		if (!existsSync(pkgDir)) continue;
		try {
			execSync("npx vitest run", {
				cwd: pkgDir,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: EVAL_TEST_TIMEOUT,
				env: { ...process.env, TESTCONTAINERS_RYUK_DISABLED: "true" },
			});
			console.log(`[supervisor] Eval gate: ${pkg} passed.`);
		} catch (err) {
			const out = extractExecOutput(err);
			console.error(`[supervisor] Eval gate: ${pkg} failed.`);
			return { passed: false, report: `${pkg} tests failed:\n${out}` };
		}
	}

	return { passed: true, report: "check + all package tests passed" };
}

/** Extract stdout+stderr from an execSync error for reporting and agent feedback. */
function extractExecOutput(err: unknown): string {
	if (err && typeof err === "object") {
		const e = err as Record<string, unknown>;
		const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString() : String(e.stdout ?? "");
		const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString() : String(e.stderr ?? "");
		return [stdout, stderr].filter(Boolean).join("\n").slice(-4000);
	}
	return String(err);
}

/**
 * runBlueProbe — semantic wrapper: "is the blue slot ready to promote?"
 *
 * Delegates to runEvalGate(). Named runBlueProbe to preserve the blue-green
 * vocabulary: this gates promotion of the staging (blue) slot to active (green).
 *
 * Env overrides for testing without running the full suite:
 *   ALEF_SUPERVISOR_TEST_EVAL_RESULT=pass|fail  — force result
 *   ALEF_SUPERVISOR_SKIP_EVAL=1                 — skip gate entirely
 */
async function runBlueProbe(repoRoot: string): Promise<{ passed: boolean; report: string }> {
	const forced = process.env.ALEF_SUPERVISOR_TEST_EVAL_RESULT;
	if (forced === "pass") return { passed: true, report: "forced pass" };
	if (forced === "fail") return { passed: false, report: "forced fail" };
	if (process.env.ALEF_SUPERVISOR_SKIP_EVAL === "1") return { passed: true, report: "eval gate skipped" };
	return runEvalGate(repoRoot);
}

export function collectFilePaths(root: string): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const entryPath = join(root, entry.name);
		if (entry.isDirectory()) {
			paths.push(...collectFilePaths(entryPath));
			continue;
		}
		if (entry.isFile()) {
			paths.push(entryPath);
		}
	}
	return paths.sort();
}

export function hashPathContents(pathToHash: string): string {
	if (!existsSync(pathToHash)) {
		throw new Error(`Hash path does not exist: ${pathToHash}`);
	}

	const digest = createHash("sha256");
	const filePaths = collectFilePaths(pathToHash);
	if (filePaths.length === 0) {
		digest.update("EMPTY");
	} else {
		for (const filePath of filePaths) {
			const relative = filePath.slice(pathToHash.length + 1).replaceAll("\\", "/");
			digest.update(relative);
			digest.update("\n");
			digest.update(readFileSync(filePath));
			digest.update("\n");
		}
	}
	return digest.digest("hex");
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

class Supervisor {
	private green: ChildProcess | undefined;
	private broker: AgentBroker;
	private sessionFile: string | undefined;
	private readonly baseArgs: string[];
	private readonly repoRoot: string;
	private readonly lifecycle = new SupervisorLifecycleMachine();
	private shuttingDown = false;
	private operationInFlight = false;
	/** Set before intentionally killing the green during rebuild/update so the exit handler ignores it. */
	private rebuildingGreen = false;
	private pendingHandoff: RuntimeHandoffEnvelope | undefined;
	private distBackupDir: string | undefined;
	/**
	 * Failure report from the most recent blue-slot eval gate.
	 * Set when runBlueProbe() returns passed=false. Passed to the new green
	 * via ALEF_SUPERVISOR_EVAL_GATE_REPORT so the agent can read the errors
	 * and attempt a self-repair before triggering another rebuild.
	 * Cleared after each spawnGreen() call.
	 */
	private evalGateReport: string | undefined;

	constructor(args: string[]) {
		this.repoRoot = findRepoRoot();
		this.sessionFile = parseSessionFromArgs(args);
		this.baseArgs = stripProbeFlag(args);
		this.pendingHandoff = this.loadPendingHandoff();
		if (this.pendingHandoff?.sessionFile && !this.sessionFile) {
			this.sessionFile = this.pendingHandoff.sessionFile;
		}

		// The broker sends messages to the green agent via IPC
		this.broker = new AgentBroker(this.repoRoot, (msg) => {
			if (this.green?.connected) {
				this.green.send(msg);
			}
		});
	}

	async run(): Promise<void> {
		process.on("SIGUSR1", () => void this.handleUpdate("rebuild"));
		process.on("SIGUSR2", () => void this.handleUpdate("rebuild"));
		process.on("SIGHUP", () => void this.handleUpdate("rebuild"));
		process.on("SIGINT", () => this.handleShutdown());
		process.on("SIGTERM", () => this.handleShutdown());

		await this.resumePendingHandoff();
		this.spawnGreen();
		const autoUpdateScope = parseUpdateScope(process.env.ALEF_SUPERVISOR_AUTO_UPDATE_SCOPE);
		if (autoUpdateScope) {
			setTimeout(() => {
				void this.handleUpdate(autoUpdateScope);
			}, 25);
		} else if (process.env.ALEF_SUPERVISOR_AUTO_REBUILD_ON_START === "1") {
			setTimeout(() => {
				void this.handleUpdate("rebuild");
			}, 25);
		}
		await new Promise<void>(() => {});
	}

	private spawnGreen(): void {
		const childArgs = buildChildArgs(this.sessionFile, this.baseArgs);
		const invocation = getGreenInvocation(this.repoRoot, childArgs);

		// Pass the eval gate failure report to the new green so the agent can
		// read the compile/test errors and attempt a self-repair before triggering
		// another rebuild. Cleared immediately after the process is spawned.
		const evalGateReport = this.evalGateReport;
		this.evalGateReport = undefined;

		// stdio: inherit stdin/stdout/stderr + IPC channel on fd 3
		this.green = spawn(invocation.command, invocation.args, {
			stdio: ["inherit", "inherit", "inherit", "ipc"],
			cwd: process.cwd(),
			env: {
				...process.env,
				ALEF_SUPERVISOR: "1",
				ALEF_REBUILD_EXIT_CODE: String(REBUILD_EXIT_CODE),
				ALEF_SUPERVISOR_ACTIVE_SLOT: this.lifecycle.getState().activeSlot,
				...(evalGateReport ? { ALEF_SUPERVISOR_EVAL_GATE_REPORT: evalGateReport } : {}),
			},
		});

		// Route IPC messages from green to the broker
		this.green.on("message", (msg: unknown) => {
			if (isAgentToSupervisor(msg)) {
				if (msg.type === "rebuild") {
					// Rebuild request — capture session and trigger
					if (msg.sessionFile) {
						this.sessionFile = msg.sessionFile;
					}
					void this.handleUpdate("rebuild");
				} else if (msg.type === "update") {
					if (msg.sessionFile) {
						this.sessionFile = msg.sessionFile;
					}
					void this.handleUpdate(msg.scope, msg.updateId);
				} else if (msg.type === "handoff_ack") {
					this.handleHandoffAck(msg.updateId);
				} else {
					this.broker.handleMessage(msg);
				}
			}
		});
		let handoffAttempts = 0;
		const handoffTimer = setInterval(() => {
			if (!this.pendingHandoff || this.pendingHandoff.phase === "finalized") {
				clearInterval(handoffTimer);
				// Clear the file when the finalized envelope was carried in from a
				// crash-recovery resume (phase was already finalized on entry).
				if (this.pendingHandoff?.phase === "finalized") {
					this.clearPendingHandoff();
				}
				return;
			}
			handoffAttempts += 1;
			if (this.green?.connected) {
				this.green.send({
					type: "handoff_prepare",
					envelope: this.pendingHandoff,
				});
			}
			if (handoffAttempts >= 20) {
				clearInterval(handoffTimer);
			}
		}, 25);

		this.green.on("exit", (code) => {
			clearInterval(handoffTimer);
			if (this.shuttingDown) {
				this.broker.killAll();
				process.exit(code ?? 0);
				return;
			}
			// Rebuild intentionally killed the green — don't propagate exit.
			if (this.rebuildingGreen) {
				return;
			}
			if (code === REBUILD_EXIT_CODE) {
				const sessionFromEnv = process.env.ALEF_CURRENT_SESSION;
				if (sessionFromEnv) this.sessionFile = sessionFromEnv;
				void this.handleUpdate("rebuild");
				return;
			}
			this.broker.killAll();
			process.exit(code ?? 0);
		});
	}

	/**
	 * resumePendingHandoff — crash-safe cold-start recovery.
	 *
	 * If a handoff envelope exists from a previous run, complete the promotion
	 * based on phase before spawning the green agent. Modelled on hegemony's
	 * resume_pending_handoff() pattern.
	 *
	 *   prepared  → canary was spawned but health unknown. Re-probe.
	 *               Pass: promote FSM, clear envelope, let spawnGreen() start new active.
	 *               Fail: rollback FSM, clear envelope, spawnGreen() restarts old slot.
	 *
	 *   acked     → canary was healthy but old slot not yet killed.
	 *               Skip health check. Finalize, update FSM, clear envelope.
	 *               The new green will receive handoff_finalize after spawn.
	 *
	 *   finalized → stale file from a completed promotion. Just delete it.
	 */
	private async resumePendingHandoff(): Promise<void> {
		if (!this.pendingHandoff) return;

		const envelope = this.pendingHandoff;
		const { phase, updateId, targetSlot } = envelope;

		if (phase === "finalized") {
			console.log("[supervisor] crash-recovery: clearing stale finalized handoff.");
			this.clearPendingHandoff();
			return;
		}

		if (phase === "acked") {
			console.log(
				`[supervisor] crash-recovery: acked envelope found — completing finalization (updateId=${updateId}).`,
			);
			// Canary was already healthy. Complete finalization and update FSM slot.
			const finalized = markRuntimeHandoffFinalized(markRuntimeHandoffAcked(envelope));
			this.persistPendingHandoff(finalized);
			this.lifecycle.apply({
				type: "spawn_staging",
				commandId: `resume-acked-spawn:${updateId}`,
				updateId,
				stagingSlot: targetSlot,
			});
			this.lifecycle.apply({
				type: "mark_staging_healthy",
				commandId: `resume-acked-healthy:${updateId}`,
				updateId,
			});
			const promoteResult = this.lifecycle.apply({
				type: "promote",
				commandId: `resume-acked-promote:${updateId}`,
				updateId,
			});
			this.lifecycle.apply({
				type: "retire_old",
				commandId: `resume-acked-retire:${updateId}`,
				updateId,
			});
			if (promoteResult.accepted) {
				console.log(`[supervisor] crash-recovery: acked handoff finalized — active slot is now ${targetSlot}.`);
			}
			// spawnGreen() will send handoff_finalize to the new green after it starts.
			// Keep pendingHandoff set so spawnGreen()'s polling loop delivers it.
			this.pendingHandoff = finalized;
			return;
		}

		// phase === "prepared": canary was spawned but health is unknown. Re-probe.
		console.log(
			`[supervisor] crash-recovery: prepared envelope found — re-probing canary health (updateId=${updateId}).`,
		);
		const probe = await runHealthCheck(this.repoRoot);

		if (probe.passed) {
			console.log("[supervisor] crash-recovery: canary healthy — completing promotion.");
			const finalized = markRuntimeHandoffFinalized(markRuntimeHandoffAcked(envelope));
			this.persistPendingHandoff(finalized);
			// Advance FSM through the full promotion cycle.
			this.lifecycle.apply({
				type: "spawn_staging",
				commandId: `resume-prep-spawn:${updateId}`,
				updateId,
				stagingSlot: targetSlot,
			});
			this.lifecycle.apply({ type: "mark_staging_healthy", commandId: `resume-prep-healthy:${updateId}`, updateId });
			this.lifecycle.apply({ type: "promote", commandId: `resume-prep-promote:${updateId}`, updateId });
			this.lifecycle.apply({ type: "retire_old", commandId: `resume-prep-retire:${updateId}`, updateId });
			console.log(`[supervisor] crash-recovery: promotion complete — active slot is now ${targetSlot}.`);
			this.pendingHandoff = finalized;
		} else {
			console.log("[supervisor] crash-recovery: canary unhealthy — rolling back.");
			this.clearPendingHandoff();
		}
	}

	private handleHandoffAck(updateId: string): void {
		if (!this.pendingHandoff || this.pendingHandoff.updateId !== updateId) {
			return;
		}
		this.pendingHandoff = markRuntimeHandoffAcked(this.pendingHandoff);
		this.persistPendingHandoff(this.pendingHandoff);
		this.pendingHandoff = markRuntimeHandoffFinalized(this.pendingHandoff);
		this.persistPendingHandoff(this.pendingHandoff);
		if (this.green?.connected) {
			this.green.send({
				type: "handoff_finalize",
				envelope: this.pendingHandoff,
			});
		}
		this.clearPendingHandoff();
	}

	private async handleUpdate(scope: UpdateScope, requestedUpdateId?: string): Promise<void> {
		if (this.operationInFlight) {
			console.log("[supervisor] Update request ignored: another operation is already running.");
			return;
		}
		this.operationInFlight = true;
		const updateId = requestedUpdateId?.trim() || randomUUID();
		try {
			if ((scope === "packages" || scope === "self") && !this.requiresTaggedPolicy(scope)) {
				console.warn(
					`[supervisor] Security policy opt-out active via ${ALLOW_UNVERIFIED_UPDATES_ENV}=1; proceeding without tag/hash gating.`,
				);
			}
			const policyError = this.validateTaggedUpdatePolicy(scope);
			if (policyError) {
				console.error(`[supervisor] ${policyError}`);
				return;
			}

			if (scope === "packages" || scope === "self") {
				console.log(`[supervisor] Running ${scope} pre-step...`);
				try {
					const packageUpdateCommand = process.env.ALEF_SUPERVISOR_PACKAGE_UPDATE_COMMAND?.trim() || "npm update";
					execSync(packageUpdateCommand, { cwd: this.repoRoot, stdio: "inherit" });
				} catch {
					console.error("[supervisor] Package update failed. Keeping current runtime.");
					return;
				}
			}

			if (scope === "self") {
				const reexeced = await this.verifyAndReexec(updateId);
				if (reexeced) {
					return;
				}
				console.error("[supervisor] Reexec verification failed. Falling back to rebuild lane.");
			}

			await this.handleRebuild(updateId);
		} finally {
			this.operationInFlight = false;
		}
	}

	private async handleRebuild(updateId: string): Promise<void> {
		// Signal the green exit handler that this kill is intentional — not a crash.
		// We must keep rebuildingGreen=true until Green-1 has ACTUALLY exited.
		// broker.killAll() resolves instantly (no agents), so clearing the flag
		// immediately after would be a race: Green-1's exit event fires ~150ms
		// after SIGTERM, long after rebuildingGreen was already reset to false.
		this.rebuildingGreen = true;
		const oldGreen = this.green;
		if (oldGreen && !oldGreen.killed) {
			oldGreen.kill("SIGTERM");
		}
		this.green = undefined;
		await this.broker.killAll();
		// Await the actual process exit before clearing the flag.
		if (oldGreen) {
			await new Promise<void>((resolve) => {
				if (oldGreen.exitCode !== null || oldGreen.signalCode !== null) {
					resolve();
				} else {
					oldGreen.once("exit", () => resolve());
				}
			});
		}
		this.rebuildingGreen = false;

		this.distBackupDir = this.createDistBackup();
		const spawnTransition = this.lifecycle.apply({
			type: "spawn_staging",
			commandId: `spawn-staging:${updateId}`,
			updateId,
			stagingSlot: this.lifecycle.nextStagingSlot(),
		});
		this.reportTransition(spawnTransition);
		if (!spawnTransition.accepted) {
			console.error("[supervisor] Failed to enter spawn_requested state; restarting active slot.");
			this.spawnGreen();
			return;
		}
		const sourceSlot = spawnTransition.from.activeSlot;
		const targetSlot = spawnTransition.to.name === "spawn_requested" ? spawnTransition.to.stagingSlot : sourceSlot;
		this.pendingHandoff = createRuntimeHandoffEnvelope({
			updateId,
			sourceSlot,
			targetSlot,
			sessionFile: this.sessionFile,
		});
		this.persistPendingHandoff(this.pendingHandoff);

		// Step 1: Build
		console.log("[supervisor] Building...");
		try {
			const buildCommand = process.env.ALEF_SUPERVISOR_BUILD_COMMAND?.trim() || "npm run build";
			execSync(buildCommand, { cwd: this.repoRoot, stdio: "inherit" });
			console.log("[supervisor] Build succeeded.");
		} catch {
			console.error("[supervisor] Build failed. Restarting with previous build.");
			this.rollbackBuild(updateId, "build_failed");
			this.spawnGreen();
			return;
		}

		const hashVerificationResult = this.verifyBuildHash();
		if (!hashVerificationResult.ok) {
			console.error(`[supervisor] ${hashVerificationResult.reason}`);
			this.rollbackBuild(updateId, "hash_validation_failed");
			this.spawnGreen();
			return;
		}
		if (hashVerificationResult.hash) {
			const tag = this.currentTaggedTarget();
			if (tag) {
				console.log(`[supervisor] Verified build hash ${hashVerificationResult.hash} for tag ${tag}.`);
			} else {
				console.log(`[supervisor] Verified build hash ${hashVerificationResult.hash}.`);
			}
		}

		// Step 2: Health check — spawn ephemeral runner, poll GET /health.
		console.log("[supervisor] Running health check...");
		const health = await runHealthCheck(this.repoRoot);
		if (!health.passed) {
			console.error(`[supervisor] Health check failed: ${health.error ?? "unknown"}`);
			this.rollbackBuild(updateId, "health_check_failed");
			this.spawnGreen();
			return;
		}
		console.log("[supervisor] Health check passed.");

		// Step 3: Blue-slot eval gate (compile + tests).
		console.log("[supervisor] Running blue-slot eval gate...");
		const probe = await runBlueProbe(this.repoRoot);

		if (probe.passed) {
			const healthyTransition = this.lifecycle.apply({
				type: "mark_staging_healthy",
				commandId: `mark-healthy:${updateId}`,
				updateId,
			});
			this.reportTransition(healthyTransition);
			if (!healthyTransition.accepted) {
				console.error("[supervisor] FSM rejected mark_staging_healthy; rolling back.");
				this.rollbackBuild(updateId, "fsm_rejected_mark_staging_healthy");
				this.spawnGreen();
				return;
			}
			const promoteTransition = this.lifecycle.apply({
				type: "promote",
				commandId: `promote:${updateId}`,
				updateId,
			});
			this.reportTransition(promoteTransition);
			if (!promoteTransition.accepted) {
				console.error("[supervisor] FSM rejected promote; rolling back.");
				this.rollbackBuild(updateId, "fsm_rejected_promote");
				this.spawnGreen();
				return;
			}
			console.log("[supervisor] Eval gate passed. Promoted staging slot.");
			// Explicit retirement: close the update cycle and clear the retiring slot.
			const retireTransition = this.lifecycle.apply({
				type: "retire_old",
				commandId: `retire-old:${updateId}`,
				updateId,
			});
			this.reportTransition(retireTransition);
			if (!retireTransition.accepted) {
				console.error("[supervisor] FSM rejected retire_old; rolling back.");
				this.rollbackBuild(updateId, "fsm_rejected_retire_old");
				this.spawnGreen();
				return;
			}
			this.cleanupDistBackup();
		} else {
			console.error("[supervisor] Eval gate failed. Rolling back to previous active slot.");
			// Store the failure report so the new green can read it and attempt self-repair.
			this.evalGateReport = probe.report;
			this.rollbackBuild(updateId, "eval_gate_failed");
		}

		// Step 3: Restart green with new build
		// Create fresh broker (old one's send function pointed to dead green)
		this.broker = new AgentBroker(this.repoRoot, (msg) => {
			if (this.green?.connected) {
				this.green.send(msg);
			}
		});
		this.spawnGreen();
	}

	private currentTaggedTarget(): string | undefined {
		return process.env.ALEF_SUPERVISOR_TARGET_TAG?.trim() || undefined;
	}

	private requiresTaggedPolicy(scope: UpdateScope): boolean {
		if (scope !== "packages" && scope !== "self") {
			return false;
		}
		return process.env[ALLOW_UNVERIFIED_UPDATES_ENV] !== "1";
	}

	private validateTaggedUpdatePolicy(scope: UpdateScope): string | undefined {
		if (!this.requiresTaggedPolicy(scope)) {
			return undefined;
		}

		const tag = process.env.ALEF_SUPERVISOR_TARGET_TAG?.trim();
		if (!tag || !SEMVER_TAG_PATTERN.test(tag)) {
			return `Tagged ${scope} flow requires ALEF_SUPERVISOR_TARGET_TAG with semver format (e.g. v0.0.1).`;
		}

		const expectedHash = process.env.ALEF_SUPERVISOR_EXPECTED_BUILD_HASH?.trim();
		if (!expectedHash || !SHA256_HEX_PATTERN.test(expectedHash)) {
			return `Tagged ${scope} flow requires ALEF_SUPERVISOR_EXPECTED_BUILD_HASH with a SHA-256 hex digest.`;
		}
		return undefined;
	}

	private verifyBuildHash(): { ok: boolean; hash?: string; reason?: string } {
		const expectedHash = process.env.ALEF_SUPERVISOR_EXPECTED_BUILD_HASH?.trim();
		if (!expectedHash) {
			return { ok: true };
		}
		if (!SHA256_HEX_PATTERN.test(expectedHash)) {
			return {
				ok: false,
				reason: "Build hash policy rejected: ALEF_SUPERVISOR_EXPECTED_BUILD_HASH must be a SHA-256 hex digest.",
			};
		}

		try {
			const command = process.env.ALEF_SUPERVISOR_BUILD_HASH_COMMAND?.trim();
			const hashPathOverride = process.env.ALEF_SUPERVISOR_BUILD_HASH_PATH?.trim();
			let actualHash: string;
			if (command) {
				const output = execSync(command, {
					cwd: this.repoRoot,
					stdio: ["ignore", "pipe", "inherit"],
				}).toString();
				actualHash = output.trim();
			} else {
				const pathToHash = hashPathOverride
					? resolve(this.repoRoot, hashPathOverride)
					: join(this.repoRoot, "packages", "coding-agent", "dist");
				actualHash = hashPathContents(pathToHash);
			}

			if (!SHA256_HEX_PATTERN.test(actualHash)) {
				return {
					ok: false,
					reason: `Build hash command returned invalid digest: ${actualHash || "<empty>"}`,
				};
			}
			if (actualHash !== expectedHash) {
				return {
					ok: false,
					hash: actualHash,
					reason: `Build hash mismatch: expected ${expectedHash} but got ${actualHash}.`,
				};
			}
			return { ok: true, hash: actualHash };
		} catch (error) {
			return {
				ok: false,
				reason: `Build hash verification failed: ${String(error)}`,
			};
		}
	}

	private reportTransition(result: SupervisorTransitionResult): void {
		const toState = result.to.name;
		if (result.accepted) {
			console.log(`[supervisor] FSM accepted ${result.command.type}: ${result.from.name} -> ${toState}`);
		} else {
			for (const diagnostic of result.diagnostics) {
				console.error(
					`[supervisor] FSM rejected ${diagnostic.command} in ${diagnostic.state}: ${diagnostic.reason}`,
				);
			}
		}
		if (this.green?.connected) {
			this.green.send({
				type: "supervisor_transition",
				updateId:
					result.command.type === "spawn_staging" ||
					result.command.type === "mark_staging_healthy" ||
					result.command.type === "promote" ||
					result.command.type === "rollback" ||
					result.command.type === "abort" ||
					result.command.type === "retire_old"
						? result.command.updateId
						: undefined,
				command: result.command.type,
				state: result.to.name,
				accepted: result.accepted,
				reason: result.diagnostics[0]?.reason,
			});
		}
	}

	private createDistBackup(): string | undefined {
		const distDir = join(this.repoRoot, "packages", "coding-agent", "dist");
		if (!existsSync(distDir)) {
			return undefined;
		}
		try {
			const backupRoot = mkdtempSync(join(tmpdir(), DIST_BACKUP_PREFIX));
			const backupDist = join(backupRoot, "dist");
			cpSync(distDir, backupDist, { recursive: true });
			return backupRoot;
		} catch (err) {
			// Backup failed (e.g. SELinux context prevents cpSync on container_file_t).
			// Log and continue without a rollback-capable backup — rebuild proceeds
			// but rollback will skip the file restore path.
			process.stderr.write(
				`[supervisor] Warning: dist backup failed (${err instanceof Error ? err.message : String(err)}). Rollback will not restore dist files.\n`,
			);
			return undefined;
		}
	}

	private rollbackBuild(updateId: string, reason: string): void {
		const rollbackTransition = this.lifecycle.apply({
			type: "rollback",
			commandId: `rollback:${updateId}:${reason}`,
			updateId,
			reason,
		});
		this.reportTransition(rollbackTransition);
		if (this.distBackupDir) {
			const backupDist = join(this.distBackupDir, "dist");
			const distDir = join(this.repoRoot, "packages", "coding-agent", "dist");
			if (existsSync(backupDist)) {
				rmSync(distDir, { recursive: true, force: true });
				cpSync(backupDist, distDir, { recursive: true });
			}
		}
		this.cleanupDistBackup();
		if (this.pendingHandoff) {
			this.pendingHandoff = markRuntimeHandoffFinalized(this.pendingHandoff);
			this.persistPendingHandoff(this.pendingHandoff);
			this.clearPendingHandoff();
		}
	}

	private cleanupDistBackup(): void {
		if (!this.distBackupDir) {
			return;
		}
		rmSync(this.distBackupDir, { recursive: true, force: true });
		this.distBackupDir = undefined;
	}

	private handoffStatePath(): string {
		const overridePath = process.env.ALEF_SUPERVISOR_HANDOFF_PATH?.trim();
		if (overridePath) {
			return resolve(overridePath);
		}
		return join(this.repoRoot, ...HANDOFF_STATE_PATH);
	}

	private loadPendingHandoff(): RuntimeHandoffEnvelope | undefined {
		const path = this.handoffStatePath();
		if (!existsSync(path)) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
			const diagnostics = validateRuntimeHandoffEnvelope(parsed);
			if (diagnostics.length > 0) {
				console.error(
					`[supervisor] Ignoring invalid hand-off envelope: ${diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ")}`,
				);
				return undefined;
			}
			return parsed as RuntimeHandoffEnvelope;
		} catch (error) {
			console.error(`[supervisor] Failed to read hand-off envelope: ${String(error)}`);
			return undefined;
		}
	}

	private persistPendingHandoff(envelope: RuntimeHandoffEnvelope): void {
		const path = this.handoffStatePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(envelope, null, 2), "utf-8");
	}

	private clearPendingHandoff(): void {
		const path = this.handoffStatePath();
		rmSync(path, { force: true });
		this.pendingHandoff = undefined;
	}

	private async verifyAndReexec(updateId: string): Promise<boolean> {
		console.log("[supervisor] Running verify-and-reexec probe...");
		if (!process.argv[1]) return false;
		const probeResult = await runSupervisorProbe(this.baseArgs, process.cwd(), this.sessionFile);
		if (!probeResult) {
			return false;
		}

		console.log("[supervisor] Probe passed. Tearing down and re-executing supervisor.");

		// Tear down cleanly BEFORE starting the replacement.
		// The old spawn+unref+exit approach started the replacement first, creating a
		// window where both old and new supervisors had a green running simultaneously.
		// Kill green and wait for it to exit before handing off.
		this.rebuildingGreen = true;
		const dyingGreen = this.green;
		this.green = undefined;
		if (dyingGreen && !dyingGreen.killed) {
			dyingGreen.kill("SIGTERM");
		}
		await this.broker.killAll();
		if (dyingGreen) {
			await new Promise<void>((resolve) => {
				if (dyingGreen.exitCode !== null || dyingGreen.signalCode !== null) {
					resolve();
				} else {
					dyingGreen.once("exit", () => resolve());
				}
			});
		}

		// spawnSync replaces the current supervisor's role:
		// - the new supervisor inherits stdin/stdout/stderr (terminal continuity)
		// - this process blocks until the new supervisor exits
		// - the new supervisor's exit code is propagated
		// Node.js has no native execv(2), so spawnSync is the closest equivalent:
		// no gap between old and new, stdio is continuous, exit code propagates.
		try {
			const reexecArgs = buildSupervisorSpawnArgs(this.baseArgs);
			const result = spawnSync(process.execPath, reexecArgs, {
				cwd: process.cwd(),
				stdio: "inherit",
				env: {
					...process.env,
					ALEF_CURRENT_SESSION: this.sessionFile ?? "",
					ALEF_SUPERVISOR_REEXEC_UPDATE_ID: updateId,
				},
			});
			process.exit(result.status ?? (result.signal ? 1 : 0));
		} catch (error) {
			console.error(`[supervisor] Reexec failed: ${String(error)}`);
			return false;
		}
	}

	private handleShutdown(): void {
		this.shuttingDown = true;
		this.broker.killAll();
		if (this.green && !this.green.killed) {
			this.green.kill("SIGINT");
		} else {
			process.exit(0);
		}
	}
}

async function runSupervisorProbe(baseArgs: string[], cwd: string, sessionFile: string | undefined): Promise<boolean> {
	if (!process.argv[1]) return false;
	const probeArgs = [...baseArgs, SUPERVISOR_PROBE_FLAG];
	if (sessionFile && !probeArgs.includes("--session")) {
		probeArgs.push("--session", sessionFile);
	}
	const spawnArgs = buildSupervisorSpawnArgs(probeArgs);
	return await new Promise<boolean>((resolvePromise) => {
		const proc = spawn(process.execPath, spawnArgs, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		proc.once("exit", (code) => {
			resolvePromise(code === 0);
		});
	});
}

async function runProbeMode(): Promise<void> {
	const repoRoot = findRepoRoot();
	const result = await runBlueProbe(repoRoot);
	process.exit(result.passed ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (hasProbeFlag(args)) {
	await runProbeMode();
}
const supervisor = new Supervisor(args);
supervisor.run().catch((err) => {
	console.error("[supervisor] Fatal:", err);
	process.exit(1);
});
