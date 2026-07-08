import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const MAIN = resolve(ROOT, "packages/cli/src/entrypoint.ts");
const TSCONFIG = resolve(ROOT, "tsconfig.json");

const POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const ENTER_WAIT_MS = 500;
const STARTUP_SETTLE_MS = 1000;

/** Options for creating a tmux-based TUI test harness. */
export interface TmuxHarnessOptions {
	cwd: string;
	replies?: Array<string | object>;
	cols?: number;
	rows?: number;
	timeoutMs?: number;
	env?: Record<string, string>;
}

/** Handle to a running tmux session with helpers for sending keys and capturing output. */
export interface TmuxHarness {
	readonly sessionName: string;
	sendKeys(text: string): void;
	type(text: string): void;
	capture(): string;
	waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
	isAlive(): boolean;
	kill(): void;
}

let counter = 0;

/** Launch the CLI inside a tmux session and return a harness for driving it. */
export async function createTmuxHarness(opts: TmuxHarnessOptions): Promise<TmuxHarness> {
	const check = spawnSync("which", ["tmux"]);
	if (check.status !== 0) throw new Error("tmux not available");

	const sessionName = `alef-test-${process.pid}-${++counter}`;
	const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const cols = opts.cols ?? DEFAULT_COLS;
	const rows = opts.rows ?? DEFAULT_ROWS;

	const envParts: string[] = [];
	envParts.push(`TSX_TSCONFIG_PATH='${TSCONFIG}'`);
	envParts.push("ALEF_DEBUG=1");
	envParts.push("NO_COLOR=1");

	if (opts.replies !== undefined) {
		envParts.push(`ALEF_SCRIPTED_REPLIES='${JSON.stringify(opts.replies)}'`);
	}

	if (opts.env) {
		for (const [k, v] of Object.entries(opts.env)) {
			envParts.push(`${k}='${v}'`);
		}
	}

	const cmd = `${envParts.join(" ")} ${process.execPath} ${TSX} ${MAIN}`;

	execFileSync("tmux", [
		"new-session", "-d",
		"-s", sessionName,
		"-c", opts.cwd,
		"-x", String(cols),
		"-y", String(rows),
		cmd,
	], { stdio: "ignore" });

	const harness: TmuxHarness = {
		sessionName,

		sendKeys(text: string) {
			execFileSync("tmux", ["send-keys", "-t", sessionName, text], { stdio: "ignore" });
		},

		type(text: string) {
			execFileSync("tmux", ["send-keys", "-t", sessionName, "-l", text], { stdio: "ignore" });
			execFileSync("tmux", ["send-keys", "-t", sessionName, "Enter"], { stdio: "ignore" });
		},

		capture(): string {
			try {
				return execFileSync("tmux", ["capture-pane", "-t", sessionName, "-p"], { encoding: "utf-8" });
			} catch {
				return "";
			}
		},

		async waitFor(pattern: RegExp, waitMs = timeout): Promise<string> {
			const deadline = Date.now() + waitMs;
			while (Date.now() < deadline) {
				const pane = harness.capture();
				if (pattern.test(pane)) return pane;
				if (pane.includes("Enter select") && !pattern.test(pane)) {
					execFileSync("tmux", ["send-keys", "-t", sessionName, "Enter"], { stdio: "ignore" });
					await new Promise((r) => setTimeout(r, ENTER_WAIT_MS));
					continue;
				}
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
			const last = harness.capture();
			throw new Error(
				`TmuxHarness.waitFor(${pattern}) timed out after ${waitMs}ms.\n` +
				`Last capture (${last.length} chars):\n${last}`,
			);
		},

		isAlive(): boolean {
			const result = spawnSync("tmux", ["has-session", "-t", sessionName]);
			return result.status === 0;
		},

		kill() {
			try {
				execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
			} catch {
				// already gone
			}
		},
	};

	await harness.waitFor(/ALEF_READY|INSERT/, timeout);
	await new Promise((r) => setTimeout(r, STARTUP_SETTLE_MS));
	return harness;
}
