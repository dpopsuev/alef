/**
 * ShellOrgan — shell execution CorpusOrgan.
 *
 * shell.exec — streaming: yields chunks as they arrive via spawn(),
 *              final event carries exitCode + isFinal: true.
 */
import { spawn } from "node:child_process";
import type { CorpusHandlerCtx, Organ } from "@dpopsuev/alef-spine";
import { defineCorpusOrgan } from "@dpopsuev/alef-spine";
import { getShellEnv } from "./shell.js";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const SHELL_EXEC_TOOL = {
	name: "shell.exec",
	description: "Execute a shell command. Streams stdout+stderr as chunks arrive. Final event carries exitCode.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" },
			timeout: { type: "number", description: "Timeout in seconds (optional)" },
		},
		required: ["command"],
	},
} as const;

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
	binDir?: string;
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

async function* streamExec(ctx: CorpusHandlerCtx, opts: ShellOrganOptions): AsyncIterable<Record<string, unknown>> {
	const command = String(ctx.payload.command ?? "");
	if (!command) throw new Error("shell.exec: command is required");
	const defaultS = opts.defaultTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_S;
	const maxS = opts.maxTimeoutSeconds ?? MAX_SHELL_TIMEOUT_S;
	const requestedS = typeof ctx.payload.timeout === "number" ? ctx.payload.timeout : defaultS;
	const clampedS = maxS > 0 ? Math.min(requestedS, maxS) : requestedS;
	const timeoutMs = clampedS > 0 ? clampedS * 1000 : undefined;
	const resolvedCommand = opts.commandPrefix ? `${opts.commandPrefix}\n${command}` : command;

	const shell = opts.shellPath ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
	const args = process.platform === "win32" ? ["/c", resolvedCommand] : ["-c", resolvedCommand];

	const child = spawn(shell, args, {
		cwd: opts.cwd,
		env: { ...getShellEnv({ binDir: opts.binDir }) },
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined) {
		timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeoutMs);
	}

	try {
		// Yield stdout/stderr chunks as they arrive
		const chunks: Buffer[] = [];
		let exitCode = 0;

		yield* (async function* () {
			const dataQueue: Buffer[] = [];
			let resolve: (() => void) | null = null;
			let done = false;

			const push = (buf: Buffer) => {
				dataQueue.push(buf);
				resolve?.();
			};

			child.stdout?.on("data", push);
			child.stderr?.on("data", push);

			child.on("close", (code) => {
				exitCode = code ?? 0;
				done = true;
				resolve?.();
			});

			while (!done || dataQueue.length > 0) {
				if (dataQueue.length === 0) {
					await new Promise<void>((r) => {
						resolve = r;
					});
					resolve = null;
				}
				while (dataQueue.length > 0) {
					const buf = dataQueue.shift()!;
					chunks.push(buf);
					yield { chunk: buf.toString("utf-8") };
				}
			}

			// Final event with full output summary + exitCode
			const output = Buffer.concat(chunks).toString("utf-8");
			if (exitCode !== 0) {
				throw Object.assign(new Error(`exit code ${exitCode}`), { exitCode, output });
			}
			yield { output, exitCode };
		})();
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShellOrgan(options: ShellOrganOptions): Organ {
	return defineCorpusOrgan(
		"shell",
		{
			"shell.exec": { tool: SHELL_EXEC_TOOL, stream: (ctx) => streamExec(ctx, options) },
		},
		{ actions: options.actions, directives: SHELL_DIRECTIVES },
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
