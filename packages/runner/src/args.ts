/**
 * CLI argument parsing.
 *
 * Usage:
 *   alef                        — interactive mode, cwd = process.cwd()
 *   alef -p "prompt"            — print mode: send one message, print reply, exit
 *   alef --print "prompt"       — same
 *   alef --cwd /path/to/repo    — set working directory for fs and shell organs
 *   alef --model claude-sonnet-4-5  — override default model
 *   alef --json                 — emit structured JSONL events instead of plain text
 *   alef --help                 — show usage
 */

export interface Args {
	/** Print mode: send one message and exit. */
	print: boolean;
	/** The prompt to send in print mode. */
	prompt: string;
	/** Working directory for FsOrgan and ShellOrgan. */
	cwd: string;
	/** Model ID override. Falls back to blueprint model, then ALEF_MODEL env var, then default. */
	modelId: string | undefined;
	/**
	 * JSON mode: emit structured JSONL events to stdout instead of plain text.
	 * Used by TUI consumers (pi, programmatic callers) to render the conversation.
	 */
	json: boolean;
	/**
	 * Path to an agent.yaml blueprint file.
	 * When provided, organs and model are configured from the blueprint.
	 * Hardcoded organ defaults (fs + shell) are used otherwise.
	 */
	blueprint: string | undefined;
	/**
	 * Diagnostic: print one tool name per line and exit.
	 * Useful for verifying which tools a blueprint exposes.
	 */
	listTools: boolean;
	/** Maximum tool-call turns per conversation. 0 = unlimited. Default: 50. */
	maxTurns: number;
	/** Loop detection threshold — same tool N times in one turn triggers guard. Default: 15. */
	loopThreshold: number;
	/**
	 * Extended thinking level for supported models (claude-3-7+).
	 * Values: minimal | low | medium | high | xhigh
	 * Default: undefined (thinking off).
	 */
	thinking: string | undefined;
	/** Resume a previous session by ID. 'last' resumes the most recent. */
	resume: string | undefined;
	/** Print all sessions for the current --cwd and exit. */
	listSessions: boolean;
	/**
	 * Disable TUI and use the readline-based interactive mode.
	 * TUI requires a TTY. Falls back automatically on non-TTY stdin.
	 */
	noTui: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-4-5";

const USAGE = `
Usage: alef [options] [prompt]

Options:
  -p, --print <prompt>   Send one message, print reply, exit
  --cwd <path>           Working directory (default: current directory)
  --model <id>           Model ID (default: ${DEFAULT_MODEL}, or ALEF_MODEL env var)
  --blueprint <path>     Load agent.yaml blueprint (configures organs and model)
  --list-tools           Print active tool names and exit (for diagnostics)
  --max-turns <n>        Max tool-call turns per run (default: 50, 0=unlimited)
  --loop-threshold <n>   Repeated tool calls before loop guard fires (default: 15)
  --thinking <level>     Enable extended thinking: minimal|low|medium|high|xhigh
  --resume [id]          Resume a previous session (id or 'last' for most recent)
  --list-sessions        Print all sessions for current --cwd and exit
  --no-tui               Use readline mode instead of TUI (also auto-set on non-TTY)
  --json                 Emit structured JSONL events (for TUI consumers)
  -h, --help             Show this help

Examples:
  alef                                 # interactive mode
  alef -p "What files are in src/?"   # print mode
  alef --cwd ~/project -p "Audit src/auth.ts"
  alef --blueprint agent.yaml -p "Fix the bug"  # blueprint-configured run
  alef --json -p "Fix the bug"        # machine-readable output
`.trim();

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		print: false,
		prompt: "",
		cwd: process.cwd(),
		modelId: process.env.ALEF_MODEL,
		json: false,
		blueprint: undefined,
		listTools: false,
		maxTurns: 50,
		loopThreshold: 15,
		thinking: undefined,
		resume: undefined,
		listSessions: false,
		noTui: false,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === "-h" || arg === "--help") {
			console.log(USAGE);
			process.exit(0);
		}

		if (arg === "-p" || arg === "--print") {
			args.print = true;
			args.prompt = argv[++i] ?? "";
			i++;
			continue;
		}

		if (arg === "--cwd") {
			args.cwd = argv[++i] ?? process.cwd();
			i++;
			continue;
		}

		if (arg === "--model") {
			args.modelId = argv[++i] ?? args.modelId;
			i++;
			continue;
		}

		if (arg === "--blueprint") {
			args.blueprint = argv[++i] ?? undefined;
			i++;
			continue;
		}

		if (arg === "--list-tools") {
			args.listTools = true;
			i++;
			continue;
		}

		if (arg === "--max-turns") {
			const n = Number.parseInt(argv[++i] ?? "50", 10);
			if (!Number.isNaN(n) && n >= 0) args.maxTurns = n;
			i++;
			continue;
		}

		if (arg === "--loop-threshold") {
			const n = Number.parseInt(argv[++i] ?? "15", 10);
			if (!Number.isNaN(n) && n > 0) args.loopThreshold = n;
			i++;
			continue;
		}

		if (arg === "--thinking") {
			args.thinking = argv[++i] ?? undefined;
			i++;
			continue;
		}

		if (arg === "--resume") {
			// Optional value: --resume <id> or bare --resume (= last)
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				args.resume = next;
				i++;
			} else {
				args.resume = "last";
			}
			i++;
			continue;
		}

		if (arg === "--list-sessions") {
			args.listSessions = true;
			i++;
			continue;
		}

		if (arg === "--no-tui") {
			args.noTui = true;
			i++;
			continue;
		}

		if (arg === "--json") {
			args.json = true;
			i++;
			continue;
		}

		// Bare positional argument — treat as prompt in print mode
		if (!arg.startsWith("-")) {
			args.print = true;
			args.prompt = arg;
			i++;
			continue;
		}

		console.error(`Unknown option: ${arg}\n\n${USAGE}`);
		process.exit(1);
	}

	if (args.print && !args.prompt.trim()) {
		console.error('Print mode requires a prompt. Use: alef -p "your prompt"');
		process.exit(1);
	}

	return args;
}
