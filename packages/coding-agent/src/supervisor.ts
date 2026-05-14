#!/usr/bin/env node
/**
 * Alef Supervisor — agent broker with blue-green deployment.
 *
 * The supervisor is the single process owner. It never runs agent logic itself.
 * Instead it:
 *   - Spawns the "green" agent (interactive session) with an IPC channel
 *   - Receives spawn/kill/status requests from the green agent via IPC
 *   - Delegates agent spawning to AgentBroker
 *   - Handles /rebuild: build → blue smoke test → promote → restart green
 *
 * Architecture:
 *   Supervisor (this file)
 *     ├── Green Agent (interactive, IPC channel on fd 3)
 *     ├── Subagent 1 (spawned by broker on green's request)
 *     ├── Subagent 2
 *     └── Blue Agent (smoke test, ephemeral)
 *
 * Usage:
 *   ./alef-dev.sh [alef args...]
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const SMOKE_TESTS = ["Respond with exactly: HEALTH_CHECK_OK", "What is 2+2? Reply with just the number."];

const SMOKE_TEST_TIMEOUT = 30_000;

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

function findAlefBin(repoRoot: string): string {
	const mainPath = join(repoRoot, "packages", "coding-agent", "dist", "main.js");
	if (existsSync(mainPath)) return mainPath;
	const srcPath = join(repoRoot, "packages", "coding-agent", "src", "main.ts");
	if (existsSync(srcPath)) return srcPath;
	throw new Error("Could not find Alef entry point");
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
// Blue-green smoke tests (run without IPC — pure JSON mode)
// ---------------------------------------------------------------------------

function runBlueProbe(
	repoRoot: string,
	prompt: string,
	timeout: number,
): Promise<{ passed: boolean; output: string; error?: string }> {
	return new Promise((res) => {
		const alefBin = findAlefBin(repoRoot);
		const isTs = alefBin.endsWith(".ts");
		const cmd = isTs ? "npx" : "node";
		const cmdArgs = isTs
			? ["tsx", alefBin, "--mode", "json", "-p", "--no-session", prompt]
			: [alefBin, "--mode", "json", "-p", "--no-session", prompt];

		const proc = spawn(cmd, cmdArgs, {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ALEF_SUPERVISOR_BLUE: "1" },
		});

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			res({ passed: false, output: "", error: `Timed out after ${timeout}ms` });
		}, timeout);

		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("exit", (code) => {
			clearTimeout(timer);
			let text = "";
			for (const line of stdout.split("\n")) {
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant") {
						for (const c of e.message.content ?? []) {
							if (c.type === "text") text += c.text;
						}
					}
				} catch {
					/* skip */
				}
			}
			const passed = text.trim().length > 0;
			res({ passed, output: text.trim(), error: passed ? undefined : `Exit ${code}: ${stderr.slice(-500)}` });
		});
	});
}

async function runSmokeTests(repoRoot: string): Promise<boolean> {
	for (const prompt of SMOKE_TESTS) {
		console.log(`[supervisor] Smoke: "${prompt.slice(0, 50)}..."`);
		const result = await runBlueProbe(repoRoot, prompt, SMOKE_TEST_TIMEOUT);
		if (result.passed) {
			console.log(`[supervisor]   PASS: ${result.output.slice(0, 80)}`);
		} else {
			console.log(`[supervisor]   FAIL: ${result.error}`);
			return false;
		}
	}
	return true;
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

		// stdio: inherit stdin/stdout/stderr + IPC channel on fd 3
		this.green = spawn(invocation.command, invocation.args, {
			stdio: ["inherit", "inherit", "inherit", "ipc"],
			cwd: process.cwd(),
			env: {
				...process.env,
				ALEF_SUPERVISOR: "1",
				ALEF_REBUILD_EXIT_CODE: String(REBUILD_EXIT_CODE),
				ALEF_SUPERVISOR_ACTIVE_SLOT: this.lifecycle.getState().activeSlot,
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

		// Step 2: Blue-green smoke tests
		console.log("[supervisor] Running smoke tests...");
		const forcedSmokeResult = process.env.ALEF_SUPERVISOR_TEST_SMOKE_RESULT;
		const passed =
			forcedSmokeResult === "pass"
				? true
				: forcedSmokeResult === "fail"
					? false
					: process.env.ALEF_SUPERVISOR_SKIP_SMOKE === "1"
						? true
						: await runSmokeTests(this.repoRoot);

		if (passed) {
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
			console.log("[supervisor] Smoke tests passed. Promoted staging slot.");
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
			console.error("[supervisor] Smoke tests failed. Rolling back to previous active slot.");
			this.rollbackBuild(updateId, "smoke_failed");
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
		const supervisorEntry = process.argv[1];
		if (!supervisorEntry) {
			return false;
		}
		const probeResult = await runSupervisorProbe(this.baseArgs, process.cwd(), this.sessionFile);
		if (!probeResult) {
			return false;
		}

		console.log("[supervisor] Probe passed. Re-executing supervisor process.");
		try {
			const replacement = spawn(process.execPath, [supervisorEntry, ...this.baseArgs], {
				cwd: process.cwd(),
				stdio: "inherit",
				env: {
					...process.env,
					ALEF_CURRENT_SESSION: this.sessionFile ?? "",
					ALEF_SUPERVISOR_REEXEC_UPDATE_ID: updateId,
				},
			});
			replacement.unref();
			await this.broker.killAll();
			if (this.green && !this.green.killed) {
				this.green.kill("SIGTERM");
			}
			process.exit(0);
		} catch (error) {
			console.error(`[supervisor] Reexec failed: ${String(error)}`);
			return false;
		}
		return true;
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
	const supervisorEntry = process.argv[1];
	if (!supervisorEntry) {
		return false;
	}
	const args = [supervisorEntry, ...baseArgs, SUPERVISOR_PROBE_FLAG];
	if (sessionFile && !args.includes("--session")) {
		args.push("--session", sessionFile);
	}
	return await new Promise<boolean>((resolvePromise) => {
		const proc = spawn(process.execPath, args, {
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
	const passed = process.env.ALEF_SUPERVISOR_SKIP_SMOKE === "1" ? true : await runSmokeTests(repoRoot);
	process.exit(passed ? 0 : 1);
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
