import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const MAIN = resolve(ROOT, "packages/cli/src/entrypoint.ts");
const TSCONFIG = resolve(ROOT, "tsconfig.json");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const POLL_INTERVAL_MS = 50;
const TAIL_CHARS = 500;

/** Options for spawning an Alef TUI in a real PTY. */
export interface TuiHarnessOptions {
	cwd: string;
	replies: Array<string | object>;
	cols?: number;
	rows?: number;
	timeoutMs?: number;
	env?: Record<string, string>;
}

/** A running Alef TUI session in a real PTY. */
export interface TuiHarness {
	/** Send raw text to the TUI (no Enter — append \r for Enter). */
	write(data: string): void;
	/** Send text followed by Enter. */
	type(text: string): void;
	/** Send Ctrl+C. */
	interrupt(): void;
	/** Wait until the output buffer matches a pattern. */
	waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>;
	/** Return everything the PTY has printed so far. */
	output(): string;
	/** Kill the PTY process. */
	kill(): void;
	/** Wait for the process to exit. Returns exit code. */
	waitForExit(timeoutMs?: number): Promise<number>;
}

/** Spawn Alef in a real PTY with scripted replies, wait for TUI ready. */
export async function createTuiHarness(opts: TuiHarnessOptions): Promise<TuiHarness> {
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import; node-pty is optional
	let spawn: (file: string, args: string[], opt: Record<string, unknown>) => import("node-pty").IPty;
	try {
		spawn = (await import("node-pty")).spawn;
	} catch {
		throw new Error("node-pty not available — install it to use TuiHarness");
	}

	const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let buf = "";
	let exitCode: number | undefined;
	let exitResolve: ((code: number) => void) | undefined;

	const pty = spawn(process.execPath, [TSX, MAIN], {
		name: "xterm-256color",
		cols: opts.cols ?? DEFAULT_COLS,
		rows: opts.rows ?? DEFAULT_ROWS,
		cwd: opts.cwd,
		env: {
			...process.env,
			ALEF_SCRIPTED_REPLIES: JSON.stringify(opts.replies),
			TSX_TSCONFIG_PATH: TSCONFIG,
			ALEF_DEBUG: "1",
			NO_COLOR: "1",
			...opts.env,
		},
	});

	pty.onData((data) => {
		buf += data;
	});
	pty.onExit(({ exitCode: code }) => {
		exitCode = code;
		exitResolve?.(code);
	});

	const harness: TuiHarness = {
		write(data: string) {
			pty.write(data);
		},
		type(text: string) {
			pty.write(`${text}\r`);
		},
		interrupt() {
			pty.write("\x03");
		},
		waitFor(pattern: RegExp, waitMs = timeout): Promise<void> {
			return new Promise((resolve, reject) => {
				if (pattern.test(buf)) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					reject(new Error(`TuiHarness.waitFor(${pattern}) timed out after ${waitMs}ms.\nOutput:\n${buf.slice(-TAIL_CHARS)}`));
				}, waitMs);
				const check = setInterval(() => {
					if (pattern.test(buf)) {
						clearInterval(check);
						clearTimeout(timer);
						resolve();
					}
				}, POLL_INTERVAL_MS);
			});
		},
		output() {
			return buf;
		},
		kill() {
			pty.kill();
		},
		waitForExit(waitMs = timeout): Promise<number> {
			if (exitCode !== undefined) return Promise.resolve(exitCode);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pty.kill();
					reject(new Error(`TuiHarness.waitForExit timed out after ${waitMs}ms`));
				}, waitMs);
				exitResolve = (code) => {
					clearTimeout(timer);
					resolve(code);
				};
			});
		},
	};

	await harness.waitFor(/ALEF_READY/, timeout);
	return harness;
}
