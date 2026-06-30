/**
 * ShellAdapter — shell execution adapter.
 *
 * shell.exec — streaming: yields chunks as they arrive via spawn(),
 *              final event carries exitCode + isFinal: true.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Adapter, AdapterLogger, PortDefinition } from "@dpopsuev/alef-kernel/adapter";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineAdapter,
	truncateTail,
	typedStreamAction,
} from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { PTYManager, ShellAdapter } from "pty-manager";
import { z } from "zod";
import { getShellConfig, getShellEnv } from "./shell.js";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const SHELL_EXEC_TOOL = {
	name: "shell.exec",
	description:
		"Execute a shell command and stream its output. Returns full stdout+stderr and exit code. Do not use to read files — use fs.read or code.read instead.",
	inputSchema: z.object({
		command: z.string().min(1).describe("Shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (optional)"),
	}),
};

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Error thrown when a shell command exceeds its configured timeout. */
export class ShellTimeoutError extends Error {
	readonly timedOut = true;
	readonly exitCode: number;
	readonly output: string;
	constructor(timeoutMs: number, exitCode: number, output: string) {
		super(`shell.exec timed out after ${timeoutMs}ms`);
		this.name = "ShellTimeoutError";
		this.exitCode = exitCode;
		this.output = output;
	}
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default timeout in seconds when the LLM omits the timeout field. */
export const DEFAULT_SHELL_TIMEOUT_S = 300;
/** Hard cap in seconds on LLM-requested timeouts. */
export const MAX_SHELL_TIMEOUT_S = 600;

/** Configuration for the shell adapter including cwd, timeouts, guards, and PTY mode. */
export interface ShellAdapterOptions {
	cwd: string;
	shellPath?: string;
	commandPrefix?: string;
	/** Pino-compatible logger. */
	logger?: AdapterLogger;
	/**
	 * Default timeout in seconds when LLM does not specify one.
	 * Default: 120. Set 0 to disable (not recommended).
	 */
	defaultTimeoutSeconds?: number;
	/**
	 * Hard cap on LLM-supplied timeout values in seconds.
	 * LLM-requested timeouts above this are silently clamped.
	 * Default: 600.
	 */
	maxTimeoutSeconds?: number;
	/** Allowlist of shell action names to mount. Default: all. */
	actions?: readonly string[];
	/** Regex patterns to block in commands. Matching commands are rejected before execution. */
	blockedPatterns?: readonly RegExp[];
	binDir?: string;
	/** Override built-in guard rules. Pass [] to disable all guards. Default: DEFAULT_GUARD_RULES. */
	guardRules?: readonly GuardRule[];
	/** Use persistent PTY sessions instead of one-shot spawn(). cd/env/aliases persist across calls. */
	usePty?: boolean;
}

// ---------------------------------------------------------------------------
// Async push queue — converts Node.js event callbacks into an async iterable.
// ---------------------------------------------------------------------------

async function* pushQueue<T>(register: (push: (item: T) => void, done: () => void) => void): AsyncIterable<T> {
	const queue: T[] = [];
	let notify: (() => void) | null = null;
	const state = { finished: false };

	register(
		(item) => {
			queue.push(item);
			notify?.();
		},
		() => {
			state.finished = true;
			notify?.();
		},
	);

	while (!state.finished || queue.length > 0) {
		if (queue.length === 0) {
			await new Promise<void>((r) => {
				notify = r;
			});
			notify = null;
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- queue.shift() returns T; length check guarantees non-undefined
		while (queue.length > 0) yield queue.shift() as T;
	}
}

// ---------------------------------------------------------------------------
// Built-in command guard — structural enforcement of agent safety rules.
// These checks run before execution. The error messages are deliberately
// prescriptive: the LLM reads them as tool results and follows the guidance.
// ---------------------------------------------------------------------------

/** Outcome of a command guard check indicating whether execution is blocked and why. */
export interface GuardResult {
	blocked: boolean;
	reason: string;
}

/** A single safety rule that tests a command string and provides a rejection reason. */
export interface GuardRule {
	test: (cmd: string) => boolean;
	reason: string;
}

/** Built-in guard rules that block destructive or unsafe shell commands before execution. */
export const DEFAULT_GUARD_RULES: readonly GuardRule[] = [
	{
		test: (cmd) => /\bgit\b/.test(cmd) && /--no-verify/.test(cmd),
		reason:
			"Blocked: --no-verify is not allowed. Pre-commit hooks are mandatory.\nFix the errors reported by the hook, then commit again without --no-verify.",
	},
	{
		test: (cmd) => /\bgit\s+reset\s+--hard\b/.test(cmd),
		reason:
			"Blocked: git reset --hard is destructive. Use git checkout <file> for targeted reverts, or git stash to save work.",
	},
	{
		test: (cmd) => /\bgit\s+push\b/.test(cmd) && /--force\b/.test(cmd) && !/--force-with-lease/.test(cmd),
		reason: "Blocked: git push --force can destroy remote history. Use --force-with-lease instead.",
	},
	{
		test: (cmd) => /\bgit\s+clean\s+-[a-zA-Z]*f/.test(cmd),
		reason: "Blocked: git clean -f permanently deletes untracked files. List files with git clean -n first.",
	},
	{
		test: (cmd) =>
			/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b.*(?:\/\s|~|\/home)/.test(cmd) ||
			/\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b.*(?:\/\s|~|\/home)/.test(cmd),
		reason: "Blocked: recursive deletion of home or root directories.",
	},
	{
		test: (cmd) => /cat\s*<<[- ]?['"]?EOF/.test(cmd) && cmd.length > 500,
		reason:
			"Blocked: large heredoc output. Communicate findings in the chat as prose, not via shell echo. Return your answer as a tool result text.",
	},
];

/** Check a command against guard rules and return whether it should be blocked. */
export function guardCommand(command: string, rules: readonly GuardRule[] = DEFAULT_GUARD_RULES): GuardResult {
	for (const rule of rules) {
		if (rule.test(command)) return { blocked: true, reason: rule.reason };
	}
	return { blocked: false, reason: "" };
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

async function* streamExec(
	ctx: { payload: { command: string; timeout?: number } },
	opts: ShellAdapterOptions,
): AsyncIterable<Record<string, unknown>> {
	const { command, timeout } = ctx.payload;
	if (!command) throw new Error("shell.exec: command is required");

	const guard = guardCommand(command, opts.guardRules ?? DEFAULT_GUARD_RULES);
	if (guard.blocked) {
		throw new Error(guard.reason);
	}

	if (opts.blockedPatterns) {
		for (const pattern of opts.blockedPatterns) {
			if (pattern.test(command)) {
				throw new Error(`shell.exec: command blocked — matches '${pattern.source}'.`);
			}
		}
	}
	const defaultS = opts.defaultTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_S;
	const maxS = opts.maxTimeoutSeconds ?? MAX_SHELL_TIMEOUT_S;
	const requestedS = timeout ?? defaultS;
	const clampedS = maxS > 0 ? Math.min(requestedS, maxS) : requestedS;
	const timeoutMs = clampedS > 0 ? clampedS * 1000 : undefined;
	const resolvedCommand = opts.commandPrefix ? `${opts.commandPrefix}\n${command}` : command;

	const shellCfg = getShellConfig(opts.shellPath);
	const child = spawn(shellCfg.shell, [...shellCfg.args, resolvedCommand], {
		cwd: opts.cwd,
		env: { ...getShellEnv({ binDir: opts.binDir }), COLUMNS: "220", LINES: "50" },
	});

	const timeout$ = { timedOut: false };
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
	let sigkillTimer2: ReturnType<typeof setTimeout> | undefined;
	let stallTimer: ReturnType<typeof setInterval> | undefined;

	if (timeoutMs !== undefined) {
		// lint-ignore: RAWTIMER hard wall-clock cap (safety net)
		sigkillTimer = setTimeout(() => {
			timeout$.timedOut = true;
			child.kill("SIGTERM");
			// lint-ignore: RAWTIMER SIGKILL escalation 5s after SIGTERM
			sigkillTimer2 = setTimeout(() => child.kill("SIGKILL"), 5000);
		}, timeoutMs);
	}

	if (child.pid) {
		let lastCpuTime = -1;
		let stallCount = 0;
		const STALL_CHECK_MS = 10_000;
		const STALL_THRESHOLD = 6;
		// lint-ignore: RAWTIMER /proc CPU stall detector, not a deadline
		stallTimer = setInterval(() => {
			try {
				const stat = readFileSync(`/proc/${child.pid}/stat`, "utf-8");
				const fields = stat.split(" ");
				const utime = Number.parseInt(fields[13], 10) || 0;
				const stime = Number.parseInt(fields[14], 10) || 0;
				const cpuTime = utime + stime;
				if (lastCpuTime >= 0 && cpuTime === lastCpuTime) {
					stallCount++;
					if (stallCount >= STALL_THRESHOLD) {
						timeout$.timedOut = true;
						child.kill("SIGTERM");
						// lint-ignore: RAWTIMER SIGKILL escalation
						setTimeout(() => child.kill("SIGKILL"), 5000);
					}
				} else {
					stallCount = 0;
				}
				lastCpuTime = cpuTime;
			} catch {
				// process gone — interval will be cleared in finally
			}
		}, STALL_CHECK_MS);
	}

	try {
		const chunks: Buffer[] = [];
		let exitCode = 0;

		for await (const buf of pushQueue<Buffer>((push, done) => {
			child.stdout.on("data", push);
			child.stderr.on("data", push);
			child.on("close", (code) => {
				exitCode = code ?? 0;
				done();
			});
		})) {
			chunks.push(buf);
			yield { chunk: buf.toString("utf-8") };
		}

		const raw = Buffer.concat(chunks).toString("utf-8");
		const tr = truncateTail(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		if (timeout$.timedOut) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- timeoutMs is guaranteed defined when timedOut is true
			throw new ShellTimeoutError(timeoutMs as number, exitCode, tr.content);
		}
		if (exitCode !== 0) {
			throw Object.assign(new Error(`exit code ${exitCode}`), { exitCode, output: tr.content });
		}
		const truncNote = tr.truncated ? ` (truncated to ${tr.totalLines} lines)` : "";
		yield withDisplay(
			{
				output: tr.content,
				exitCode,
				truncated: tr.truncated,
				totalLines: tr.totalLines,
				totalBytes: tr.totalBytes,
			},
			{ text: `\`\`\`\n${tr.content}${truncNote}\n\`\`\``, mimeType: "text/markdown" },
		);
	} finally {
		if (sigkillTimer) clearTimeout(sigkillTimer);
		if (sigkillTimer2) clearTimeout(sigkillTimer2);
		if (stallTimer) clearInterval(stallTimer);
	}
}

// ---------------------------------------------------------------------------
// PTY pool — persistent terminal sessions keyed by cwd
// ---------------------------------------------------------------------------

class PtyPool {
	private readonly manager = new PTYManager();
	private readonly sessions = new Map<string, string>();

	constructor() {
		this.manager.registerAdapter(new ShellAdapter());
	}

	async getOrCreate(cwd: string): Promise<{ id: string; manager: PTYManager }> {
		const existing = this.sessions.get(cwd);
		if (existing) return { id: existing, manager: this.manager };
		const handle = await this.manager.spawn({
			name: `shell-${cwd}`,
			type: "shell",
			workdir: cwd,
			cols: 220,
			rows: 50,
		});
		this.sessions.set(cwd, handle.id);
		return { id: handle.id, manager: this.manager };
	}

	async dispose(): Promise<void> {
		for (const [, id] of this.sessions) {
			await this.manager.stop(id);
		}
		this.sessions.clear();
	}
}

// ---------------------------------------------------------------------------
// PTY-based streaming handler
// ---------------------------------------------------------------------------

async function* streamExecPty(
	ctx: { payload: { command: string; timeout?: number } },
	opts: ShellAdapterOptions,
	pool: PtyPool,
): AsyncIterable<Record<string, unknown>> {
	const { command, timeout } = ctx.payload;
	if (!command) throw new Error("shell.exec: command is required");

	const guard = guardCommand(command, opts.guardRules ?? DEFAULT_GUARD_RULES);
	if (guard.blocked) throw new Error(guard.reason);

	if (opts.blockedPatterns) {
		for (const pattern of opts.blockedPatterns) {
			if (pattern.test(command)) throw new Error(`shell.exec: command blocked — matches '${pattern.source}'.`);
		}
	}

	const defaultS = opts.defaultTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_S;
	const maxS = opts.maxTimeoutSeconds ?? MAX_SHELL_TIMEOUT_S;
	const requestedS = timeout ?? defaultS;
	const clampedS = maxS > 0 ? Math.min(requestedS, maxS) : requestedS;
	const timeoutMs = clampedS > 0 ? clampedS * 1000 : undefined;

	const { id, manager } = await pool.getOrCreate(opts.cwd);
	const terminal = manager.attachTerminal(id);
	if (!terminal) throw new Error("shell.exec: failed to attach to PTY session");

	const chunks: string[] = [];

	const readyPromise = new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs) {
			// lint-ignore: RAWTIMER hard wall-clock cap for PTY command
			timer = setTimeout(() => {
				reject(new ShellTimeoutError(timeoutMs, -1, chunks.join("")));
			}, timeoutMs);
		}

		manager.once("session_ready", (handle: { id: string }) => {
			if (handle.id === id) {
				if (timer) clearTimeout(timer);
				resolve();
			}
		});
	});

	const offData = terminal.onData((data: string) => {
		chunks.push(data);
	});

	manager.send(id, command);

	try {
		await readyPromise;
	} finally {
		offData();
	}

	const raw = chunks.join("");
	const tr = truncateTail(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const truncNote = tr.truncated ? ` (truncated to ${tr.totalLines} lines)` : "";
	yield withDisplay(
		{
			output: tr.content,
			exitCode: 0,
			truncated: tr.truncated,
			totalLines: tr.totalLines,
			totalBytes: tr.totalBytes,
		},
		{ text: `\`\`\`\n${tr.content}${truncNote}\n\`\`\``, mimeType: "text/markdown" },
	);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a shell adapter with streaming exec, command guards, and optional PTY persistence. */
export function createShellAdapter(options: ShellAdapterOptions): Adapter {
	const pool = options.usePty ? new PtyPool() : null;
	const exec = pool
		? (ctx: { payload: { command: string; timeout?: number } }) => streamExecPty(ctx, options, pool)
		: (ctx: { payload: { command: string; timeout?: number } }) => streamExec(ctx, options);

	return defineAdapter(
		"shell",
		{
			command: { "shell.exec": typedStreamAction(SHELL_EXEC_TOOL, exec) },
		},
		{
			actions: options.actions,
			directives: SHELL_DIRECTIVES,
			logger: options.logger,
			description: "Execute shell commands in the workspace.",
			labels: ["shell", "exec", "process"],
			contributions: {
				port: {
					name: "shell",
					eventPattern: "command/shell.",
					cardinality: "zero-or-one",
				} satisfies PortDefinition,
				"event.weights": {
					"shell.exec": 1.5,
				},
			},
			publishSchemas: {
				event: {
					// Streaming: discriminate on isFinal — intermediate events carry chunk,
					// final event carries output + exitCode.
					"shell.exec": z.discriminatedUnion("isFinal", [
						z.object({ chunk: z.string().min(1), isFinal: z.literal(false) }),
						z.object({
							output: z.string().min(1),
							exitCode: z.number(),
							isFinal: z.literal(true),
							truncated: z.boolean().optional(),
							totalLines: z.number().optional(),
							totalBytes: z.number().optional(),
						}),
					]),
				},
			},
		},
	);
}

const SHELL_DIRECTIVES = [
	`**shell.exec tool guidance**
- Use shell.exec for: running tests, compilation, git operations, package installs, and inspecting process output.
- Do NOT use shell.exec to read files — use fs.read instead. Do NOT use it to search file contents — use fs.grep.
- Default timeout is 120 seconds. Supply a longer timeout for slow operations (e.g. npm install).
- Commands run with the working directory set to the project root. Use relative paths.
- Avoid destructive commands (rm -rf, git reset --hard) unless the user explicitly requests them.`,
];
