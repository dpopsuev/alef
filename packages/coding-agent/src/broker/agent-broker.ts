/**
 * AgentBroker — OTP-inspired supervisor for agent processes.
 *
 * Manages the lifecycle of spawned agents with:
 *   - Restart policies: permanent / transient / temporary (Erlang/OTP)
 *   - Restart intensity: max N restarts per T seconds before giving up
 *   - Graceful shutdown: configurable timeout per child, then SIGKILL
 *   - Ordered shutdown: children stopped in reverse-start order
 *   - Health tracking: restart count, crash history
 *
 * Architecture note: this is a flat one_for_one supervisor. Each child
 * is independent — a crash in one does not affect others.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToSupervisor, RestartPolicy, SpawnConfig, SpawnUsage, SupervisorToAgent } from "./protocol.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_AGENTS = 8;

/** Default: max 3 restarts per 60 seconds before giving up */
const DEFAULT_MAX_RESTART_INTENSITY = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

/** Default shutdown timeout before SIGKILL */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManagedAgent {
	id: string;
	name: string;
	config: SpawnConfig;
	proc: ChildProcess;
	pid: number;
	startedAt: number;
	running: boolean;
	stdout: string;
	stderr: string;
	usage: SpawnUsage;
	tmpDir?: string;

	// OTP-inspired fields
	restartPolicy: RestartPolicy;
	restartCount: number;
	/** Timestamps of recent crashes (for intensity tracking) */
	crashHistory: number[];
	shutdownTimeout: number;
	/** Order in which this child was started (for ordered shutdown) */
	startOrder: number;
}

// ---------------------------------------------------------------------------
// AgentBroker
// ---------------------------------------------------------------------------

export class AgentBroker {
	private agents = new Map<string, ManagedAgent>();
	private repoRoot: string;
	private startCounter = 0;

	/** Max restarts per window before the child is considered failed */
	private maxRestartIntensity: number;
	/** Time window (ms) for restart intensity tracking */
	private restartWindowMs: number;

	constructor(
		repoRoot: string,
		private sendToGreen: (msg: SupervisorToAgent) => void,
		options?: { maxRestartIntensity?: number; restartWindowMs?: number },
	) {
		this.repoRoot = repoRoot;
		this.maxRestartIntensity = options?.maxRestartIntensity ?? DEFAULT_MAX_RESTART_INTENSITY;
		this.restartWindowMs = options?.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
	}

	handleMessage(msg: AgentToSupervisor): void {
		switch (msg.type) {
			case "spawn":
				this.handleSpawn(msg.id, msg.config);
				break;
			case "kill":
				this.handleKill(msg.id);
				break;
			case "status":
				this.handleStatus();
				break;
			case "rebuild":
				this.sendToGreen({ type: "rebuild_ack" });
				break;
		}
	}

	/**
	 * Graceful ordered shutdown — children stopped in reverse-start order.
	 * Each child gets its configured shutdown timeout, then SIGKILL.
	 */
	async killAll(): Promise<void> {
		const ordered = [...this.agents.values()].filter((a) => a.running).sort((a, b) => b.startOrder - a.startOrder); // reverse start order

		const promises = ordered.map((agent) => this.shutdownChild(agent));
		await Promise.all(promises);
		this.agents.clear();
	}

	// =====================================================================
	// Spawn
	// =====================================================================

	private handleSpawn(id: string, config: SpawnConfig): void {
		const runningCount = [...this.agents.values()].filter((a) => a.running).length;
		if (runningCount >= MAX_CONCURRENT_AGENTS) {
			this.sendToGreen({
				type: "spawn_error",
				id,
				error: `Max concurrent agents (${MAX_CONCURRENT_AGENTS}) reached. Kill one first.`,
			});
			return;
		}

		try {
			const managed = this.spawnAgent(id, config);
			this.agents.set(id, managed);
			this.sendToGreen({ type: "spawn_started", id, pid: managed.pid });
		} catch (err) {
			this.sendToGreen({
				type: "spawn_error",
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private spawnAgent(id: string, config: SpawnConfig, restartCount = 0, crashHistory: number[] = []): ManagedAgent {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];

		if (config.model) args.push("--model", config.model);
		if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
		if (config.sessionFile) args.push("--session", config.sessionFile);

		let tmpDir: string | undefined;

		if (config.systemPrompt?.trim()) {
			tmpDir = mkdtempSync(join(tmpdir(), `alef-broker-${config.name}-`));
			const promptPath = join(tmpDir, "system-prompt.md");
			writeFileSync(promptPath, config.systemPrompt, "utf-8");
			args.push("--append-system-prompt", promptPath);
		}

		args.push(`Task: ${config.prompt}`);

		const { command, cmdArgs } = this.getInvocation(args);
		const cwd = config.cwd ?? process.cwd();

		const proc = spawn(command, cmdArgs, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_BROKER_AGENT_ID: id,
				ALEF_BROKER_AGENT_NAME: config.name,
			},
		});

		const managed: ManagedAgent = {
			id,
			name: config.name,
			config,
			proc,
			pid: proc.pid ?? 0,
			startedAt: Date.now(),
			running: true,
			stdout: "",
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			tmpDir,
			restartPolicy: config.restart ?? "temporary",
			restartCount,
			crashHistory: [...crashHistory],
			shutdownTimeout: config.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			startOrder: this.startCounter++,
		};

		// Timeout
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		if (config.timeout) {
			timeoutTimer = setTimeout(() => {
				if (managed.running) {
					proc.kill("SIGTERM");
				}
			}, config.timeout);
		}

		// Stream stdout
		let buffer = "";
		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				managed.stdout += `${line}\n`;

				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						managed.usage.turns++;
						const usage = event.message.usage;
						if (usage) {
							managed.usage.input += usage.input || 0;
							managed.usage.output += usage.output || 0;
							managed.usage.cacheRead += usage.cacheRead || 0;
							managed.usage.cacheWrite += usage.cacheWrite || 0;
							managed.usage.cost += usage.cost?.total || 0;
						}
					}
					this.sendToGreen({ type: "spawn_event", id, event });
				} catch {
					// Not JSON
				}
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			managed.stderr += data.toString();
		});

		proc.on("exit", (code) => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			managed.running = false;

			const output = this.extractAssistantText(managed.stdout);

			this.sendToGreen({
				type: "spawn_complete",
				id,
				exitCode: code ?? 1,
				output,
				stderr: managed.stderr.slice(-2000),
				usage: managed.usage,
			});

			this.cleanupTmpDir(managed.tmpDir);

			// Restart decision (OTP logic)
			this.maybeRestart(managed, code ?? 1);
		});

		return managed;
	}

	// =====================================================================
	// OTP restart logic
	// =====================================================================

	private maybeRestart(agent: ManagedAgent, exitCode: number): void {
		const policy = agent.restartPolicy;
		const normalExit = exitCode === 0;

		// Determine if restart is warranted
		let shouldRestart = false;
		switch (policy) {
			case "permanent":
				shouldRestart = true;
				break;
			case "transient":
				shouldRestart = !normalExit;
				break;
			case "temporary":
				shouldRestart = false;
				break;
		}

		if (!shouldRestart) return;

		// Check restart intensity
		const now = Date.now();
		agent.crashHistory.push(now);

		// Prune old crashes outside the window
		const windowStart = now - this.restartWindowMs;
		agent.crashHistory = agent.crashHistory.filter((t) => t >= windowStart);

		if (agent.crashHistory.length > this.maxRestartIntensity) {
			this.sendToGreen({
				type: "spawn_error",
				id: agent.id,
				error: `Agent "${agent.name}" exceeded restart intensity (${this.maxRestartIntensity} restarts in ${this.restartWindowMs / 1000}s). Giving up.`,
			});
			return;
		}

		// Restart
		agent.restartCount++;
		try {
			const restarted = this.spawnAgent(agent.id, agent.config, agent.restartCount, agent.crashHistory);
			this.agents.set(agent.id, restarted);
			this.sendToGreen({ type: "spawn_started", id: agent.id, pid: restarted.pid });
		} catch (err) {
			this.sendToGreen({
				type: "spawn_error",
				id: agent.id,
				error: `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// =====================================================================
	// Graceful shutdown
	// =====================================================================

	private shutdownChild(agent: ManagedAgent): Promise<void> {
		if (!agent.running || !agent.proc || agent.proc.killed) {
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			const proc = agent.proc;

			// SIGTERM first (graceful)
			proc.kill("SIGTERM");

			const killTimer = setTimeout(() => {
				// SIGKILL if still alive after timeout
				if (!proc.killed) {
					proc.kill("SIGKILL");
				}
			}, agent.shutdownTimeout);

			proc.on("exit", () => {
				clearTimeout(killTimer);
				agent.running = false;
				this.cleanupTmpDir(agent.tmpDir);
				resolve();
			});
		});
	}

	// =====================================================================
	// Kill (user-requested)
	// =====================================================================

	private handleKill(id: string): void {
		const agent = this.agents.get(id);
		if (!agent) {
			this.sendToGreen({ type: "spawn_error", id, error: `No agent with id "${id}"` });
			return;
		}
		// Downgrade to temporary so it doesn't restart after being killed
		agent.restartPolicy = "temporary";
		if (agent.running && agent.proc && !agent.proc.killed) {
			agent.proc.kill("SIGTERM");
		}
	}

	// =====================================================================
	// Status
	// =====================================================================

	private handleStatus(): void {
		const agents = [...this.agents.values()].map((a) => ({
			id: a.id,
			name: a.name,
			pid: a.pid,
			running: a.running,
			startedAt: a.startedAt,
			restart: a.restartPolicy,
			restartCount: a.restartCount,
		}));
		this.sendToGreen({ type: "status_response", agents });
	}

	// =====================================================================
	// Helpers
	// =====================================================================

	private getInvocation(args: string[]): { command: string; cmdArgs: string[] } {
		const mainPath = join(this.repoRoot, "packages", "coding-agent", "dist", "main.js");
		if (existsSync(mainPath)) {
			return { command: process.execPath, cmdArgs: [mainPath, ...args] };
		}
		return { command: "alef", cmdArgs: args };
	}

	private extractAssistantText(stdout: string): string {
		let output = "";
		for (const line of stdout.split("\n")) {
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const content of event.message.content ?? []) {
						if (content.type === "text") output += content.text;
					}
				}
			} catch {
				// skip
			}
		}
		return output.trim();
	}

	private cleanupTmpDir(tmpDir: string | undefined): void {
		if (!tmpDir) return;
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
}
