import { execFileSync, execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SESSION_NAME = "alef-debug";
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
const RENDER_SETTLE_MS = 5000;

/** Parse --flag value pairs from the debug tui args. */
function parseDebugTuiArgs(argv: string[]): {
	prompt: string | undefined;
	reply: string;
	attach: boolean;
	live: boolean;
	cols: number;
	rows: number;
	timeoutMs: number;
} {
	let prompt: string | undefined;
	let reply = "(debug reply)";
	let attach = false;
	let live = false;
	let cols = DEFAULT_COLS;
	let rows = DEFAULT_ROWS;
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--reply" && argv[i + 1]) {
			reply = argv[++i];
		} else if (arg === "--attach") {
			attach = true;
		} else if (arg === "--live") {
			live = true;
		} else if (arg === "--cols" && argv[i + 1]) {
			cols = parseInt(argv[++i], 10);
		} else if (arg === "--rows" && argv[i + 1]) {
			rows = parseInt(argv[++i], 10);
		} else if (arg === "--timeout" && argv[i + 1]) {
			timeoutMs = parseInt(argv[++i], 10);
		} else if (!arg.startsWith("-") && !prompt) {
			prompt = arg;
		}
	}

	return { prompt, reply, attach, live, cols, rows, timeoutMs };
}

/** Capture the current tmux pane content. */
function captureTmux(): string {
	return execFileSync("tmux", ["capture-pane", "-t", SESSION_NAME, "-p"], { encoding: "utf-8" });
}

/** Kill the debug tmux session if it exists. */
function killSession(): void {
	try {
		execFileSync("tmux", ["kill-session", "-t", SESSION_NAME], { stdio: "ignore" });
	} catch {
		// session already gone
	}
}

/** Spawn Alef in a tmux session, optionally send a prompt, capture or attach. */
export async function runDebugTui(args: string[], cwd: string): Promise<void> {
	const opts = parseDebugTuiArgs(args);

	const tmuxCheck = spawnSync("which", ["tmux"]);
	if (tmuxCheck.status !== 0) {
		console.error("tmux is not installed. Install it with: sudo dnf install tmux");
		process.exit(1);
	}

	killSession();

	const root = resolve(import.meta.dirname, "../../../..");
	const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
	const main = resolve(root, "packages/cli/src/entrypoint.ts");

	const envParts = [`ALEF_DEBUG=1`, `TSX_TSCONFIG_PATH='${resolve(root, "tsconfig.json")}'`];
	if (!opts.live) {
		envParts.push(`ALEF_SCRIPTED_REPLIES='${JSON.stringify([opts.reply])}'`);
	}
	const cmd = `${envParts.join(" ")} ${process.execPath} ${tsx} ${main}`;

	execFileSync(
		"tmux",
		["new-session", "-d", "-s", SESSION_NAME, "-x", String(opts.cols), "-y", String(opts.rows), cmd],
		{ cwd, stdio: "ignore" },
	);

	console.error(`[debug tui] spawned in tmux session '${SESSION_NAME}' (${opts.cols}×${opts.rows})`);

	const deadline = Date.now() + opts.timeoutMs;
	let ready = false;
	while (Date.now() < deadline) {
		const pane = captureTmux();
		if (pane.includes("ALEF_READY") || pane.includes("INSERT")) {
			ready = true;
			break;
		}
		if (pane.includes("Enter select") && !pane.includes("INSERT")) {
			execFileSync("tmux", ["send-keys", "-t", SESSION_NAME, "Enter"], { stdio: "ignore" });
			console.error("[debug tui] picker detected — auto-selecting first option");
			await new Promise((r) => setTimeout(r, 500));
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	if (!ready) {
		const pane = captureTmux();
		console.error("[debug tui] TUI did not become ready within timeout. Last pane:");
		console.log(pane);
		killSession();
		process.exit(1);
	}

	console.error("[debug tui] TUI ready");

	if (opts.prompt) {
		execFileSync("tmux", ["send-keys", "-t", SESSION_NAME, "-l", opts.prompt], { stdio: "ignore" });
		execFileSync("tmux", ["send-keys", "-t", SESSION_NAME, "Enter"], { stdio: "ignore" });
		console.error(`[debug tui] sent: "${opts.prompt}"`);
		await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
	}

	if (opts.attach) {
		console.error("[debug tui] attaching — Ctrl+B D to detach, Ctrl+C to quit alef");
		execSync(`tmux attach -t ${SESSION_NAME}`, { stdio: "inherit" });
	} else {
		const capture = captureTmux();
		console.log(capture);
		killSession();
	}
}
