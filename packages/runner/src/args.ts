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
	/** Model ID override. Falls back to ALEF_MODEL env var, then default. */
	modelId: string;
	/**
	 * JSON mode: emit structured JSONL events to stdout instead of plain text.
	 * Used by TUI consumers (pi, programmatic callers) to render the conversation.
	 */
	json: boolean;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";

const USAGE = `
Usage: alef [options] [prompt]

Options:
  -p, --print <prompt>   Send one message, print reply, exit
  --cwd <path>           Working directory (default: current directory)
  --model <id>           Model ID (default: ${DEFAULT_MODEL}, or ALEF_MODEL env var)
  --json                 Emit structured JSONL events (for TUI consumers)
  -h, --help             Show this help

Examples:
  alef                                 # interactive mode
  alef -p "What files are in src/?"   # print mode
  alef --cwd ~/project -p "Audit src/auth.ts"
  alef --json -p "Fix the bug"        # machine-readable output
`.trim();

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		print: false,
		prompt: "",
		cwd: process.cwd(),
		modelId: process.env.ALEF_MODEL ?? DEFAULT_MODEL,
		json: false,
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
