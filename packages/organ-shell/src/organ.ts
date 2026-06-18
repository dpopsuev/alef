/**
 * ShellOrgan — shell execution organ.
 *
 * shell.exec — streaming: yields chunks as they arrive via spawn(),
 *              final event carries exitCode + isFinal: true.
 */
import { spawn } from "node:child_process";
import type { Organ, OrganLogger, PortDefinition } from "@dpopsuev/alef-kernel";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineOrgan,
	truncateTail,
	typedStreamAction,
	withDisplay,
} from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { getShellConfig, getShellEnv } from "./shell.js";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const SHELL_EXEC_TOOL = {
	name: "shell.exec",
	description:
		"Execute a shell command and stream its output. Returns full stdout+stderr and exit code. Do not use to read files — use fs.read or lector.read instead.",
	inputSchema: z.object({
		command: z.string().min(1).describe("Shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (optional)"),
	}),
};

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

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

/** Default timeout when the LLM omits the timeout field. 120 seconds. */
export const DEFAULT_SHELL_TIMEOUT_S = 120;
/** Hard cap: the LLM cannot request a timeout longer than this. 600 seconds. */
export const MAX_SHELL_TIMEOUT_S = 600;

export interface ShellOrganOptions {
	cwd: string;
	shellPath?: string;
	commandPrefix?: string;
	/** Pino-compatible logger. */
	logger?: OrganLogger;
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
}

// ---------------------------------------------------------------------------
// Async push queue — converts Node.js event callbacks into an async iterable.
// ---------------------------------------------------------------------------

async function* pushQueue<T>(register: (push: (item: T) => void, done: () => void) => void): AsyncIterable<T> {
	const queue: T[] = [];
	let notify: (() => void) | null = null;
	let finished = false;

	register(
		(item) => {
			queue.push(item);
			notify?.();
		},
		() => {
			finished = true;
			notify?.();
		},
	);

	while (!finished || queue.length > 0) {
		if (queue.length === 0) {
			await new Promise<void>((r) => {
				notify = r;
			});
			notify = null;
		}
		while (queue.length > 0) yield queue.shift() as T;
	}
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

async function* streamExec(
	ctx: { payload: { command: string; timeout?: number } },
	opts: ShellOrganOptions,
): AsyncIterable<Record<string, unknown>> {
	const { command, timeout } = ctx.payload;
	if (!command) throw new Error("shell.exec: command is required");

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

	let timedOut = false;
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
	let sigkillTimer2: ReturnType<typeof setTimeout> | undefined;

	if (timeoutMs !== undefined) {
		// lint-ignore: RAWTIMER two-stage SIGTERM→SIGKILL escalation, not a stall detector
		sigkillTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			// lint-ignore: RAWTIMER SIGKILL escalation 5s after SIGTERM
			sigkillTimer2 = setTimeout(() => child.kill("SIGKILL"), 5000);
		}, timeoutMs);
	}

	try {
		const chunks: Buffer[] = [];
		let exitCode = 0;

		for await (const buf of pushQueue<Buffer>((push, done) => {
			child.stdout?.on("data", push);
			child.stderr?.on("data", push);
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
		if (timedOut) {
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
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShellOrgan(options: ShellOrganOptions): Organ {
	return defineOrgan(
		"shell",
		{
			motor: { "shell.exec": typedStreamAction(SHELL_EXEC_TOOL, (ctx) => streamExec(ctx, options)) },
		},
		{
			actions: options.actions,
			directives: SHELL_DIRECTIVES,
			logger: options.logger,
			description: "Execute shell commands in the workspace.",
			labels: ["shell", "exec", "process"],
			contributions: {
				port: { name: "shell", eventPattern: "motor/shell.", cardinality: "zero-or-one" } satisfies PortDefinition,
			},
			publishSchemas: {
				sense: {
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
