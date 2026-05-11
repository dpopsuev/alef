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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentBroker } from "./broker/agent-broker.js";
import { isAgentToSupervisor } from "./broker/protocol.js";

const REBUILD_EXIT_CODE = 75;

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

function parseSessionFromArgs(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--session" && i + 1 < args.length) {
			return args[i + 1];
		}
	}
	return undefined;
}

function buildChildArgs(sessionFile: string | undefined, baseArgs: string[]): string[] {
	const args = [...baseArgs];
	if (sessionFile) {
		const hasSession = args.some((a, i) => a === "--session" && i + 1 < args.length);
		if (!hasSession) {
			args.unshift("--session", sessionFile);
		}
	}
	return args;
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

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

class Supervisor {
	private green: ChildProcess | undefined;
	private broker: AgentBroker;
	private sessionFile: string | undefined;
	private readonly baseArgs: string[];
	private readonly repoRoot: string;
	private shuttingDown = false;

	constructor(args: string[]) {
		this.repoRoot = findRepoRoot();
		this.sessionFile = parseSessionFromArgs(args);
		this.baseArgs = args;

		// The broker sends messages to the green agent via IPC
		this.broker = new AgentBroker(this.repoRoot, (msg) => {
			if (this.green?.connected) {
				this.green.send(msg);
			}
		});
	}

	async run(): Promise<void> {
		process.on("SIGUSR1", () => void this.handleRebuild());
		process.on("SIGINT", () => this.handleShutdown());
		process.on("SIGTERM", () => this.handleShutdown());

		this.spawnGreen();
		await new Promise<void>(() => {});
	}

	private spawnGreen(): void {
		const alefBin = findAlefBin(this.repoRoot);
		const childArgs = buildChildArgs(this.sessionFile, this.baseArgs);
		const isTs = alefBin.endsWith(".ts");
		const cmd = isTs ? "npx" : "node";
		const cmdArgs = isTs ? ["tsx", alefBin, ...childArgs] : [alefBin, ...childArgs];

		// stdio: inherit stdin/stdout/stderr + IPC channel on fd 3
		this.green = spawn(cmd, cmdArgs, {
			stdio: ["inherit", "inherit", "inherit", "ipc"],
			cwd: process.cwd(),
			env: {
				...process.env,
				ALEF_SUPERVISOR: "1",
				ALEF_REBUILD_EXIT_CODE: String(REBUILD_EXIT_CODE),
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
					void this.handleRebuild();
				} else {
					this.broker.handleMessage(msg);
				}
			}
		});

		this.green.on("exit", (code) => {
			if (this.shuttingDown) {
				this.broker.killAll();
				process.exit(code ?? 0);
				return;
			}
			if (code === REBUILD_EXIT_CODE) {
				const sessionFromEnv = process.env.ALEF_CURRENT_SESSION;
				if (sessionFromEnv) this.sessionFile = sessionFromEnv;
				void this.handleRebuild();
				return;
			}
			this.broker.killAll();
			process.exit(code ?? 0);
		});
	}

	private async handleRebuild(): Promise<void> {
		// Kill green and all its subagents
		if (this.green && !this.green.killed) {
			this.green.kill("SIGTERM");
		}
		this.green = undefined;
		this.broker.killAll();

		// Step 1: Build
		console.log("[supervisor] Building...");
		try {
			execSync("npm run build", { cwd: this.repoRoot, stdio: "inherit" });
			console.log("[supervisor] Build succeeded.");
		} catch {
			console.error("[supervisor] Build failed. Restarting with previous build.");
			this.spawnGreen();
			return;
		}

		// Step 2: Blue-green smoke tests
		console.log("[supervisor] Running smoke tests...");
		const passed = await runSmokeTests(this.repoRoot);

		if (passed) {
			console.log("[supervisor] Smoke tests passed. Promoting blue to green.");
		} else {
			console.error("[supervisor] Smoke tests failed. Starting with new build anyway (graceful degradation).");
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const supervisor = new Supervisor(args);
supervisor.run().catch((err) => {
	console.error("[supervisor] Fatal:", err);
	process.exit(1);
});
