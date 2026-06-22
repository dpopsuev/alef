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
	/**
	 * Diagnostic: print one organ per line (name, labels, description) and exit.
	 * Useful for verifying which organs are loaded and their metadata.
	 */
	listOrgans: boolean;
	/** Maximum tool-call turns per conversation. 0 = unlimited. Default: 50. */
	maxTurns: number;

	/**
	 * Extended thinking level for supported models (claude-3-7+).
	 * Values: minimal | low | medium | high | xhigh
	 * Default: undefined (thinking off).
	 */
	thinking: string | undefined;
	/** Resume a previous session by ID. 'last' resumes the most recent. */
	resume: string | undefined;
	/**
	 * debug subcommand and its args: 'session [id|--list]'
	 * Invoked as: alef debug session [args...]
	 */
	debugSubcmd: string | undefined;
	debugSubcmdArgs: string[];
	/** Print all sessions for the current --cwd and exit. */
	listSessions: boolean;
	/**
	 * Disable TUI and use the readline-based interactive mode.
	 * TUI requires a TTY. Falls back automatically on non-TTY stdin.
	 */
	noTui: boolean;
	/** Skip permission gates — allow all tool calls. */
	yolo: boolean;

	/**
	 * HTTP port for the Router organ (HTTP/SSE bridge).
	 * When set, the router is mounted and the agent accepts requests on this port.
	 * External processes connect to GET /events for the SSE stream and
	 * POST /message to send user messages.
	 * Default: undefined (router disabled).
	 */
	serve: number | undefined;
	/**
	 * Daemon mode: start headlessly on a random port, write ~/.alef/daemon.json,
	 * and keep running until killed. Implies --serve 0 --no-tui.
	 */
	daemon: boolean;
	/**
	 * Attach mode: connect to a running daemon via its SSE surface and run the
	 * TUI against the remote session. Value is the cwd of the daemon to attach
	 * to, or 'last' for the most recently started daemon.
	 */
	attach: string | undefined;
	/**
	 * Blueprint profile name. When set, loads agent.<profile>.yaml alongside
	 * the base agent.yaml and deep-merges it (overlay wins on conflicts).
	 * Example: --profile dev loads agent.dev.yaml from the same directory.
	 */
	profile: string | undefined;
	/**
	 * Debug mode: sets log level to debug and emits verbose lifecycle events
	 * to the session JSONL (bus: "debug").
	 */
	debug: boolean;

	// ── Package manager subcommands ──────────────────────────────────────────
	/** alef install <organ>[@version] */
	pmInstall: string | undefined;
	/** alef remove <organ> */
	pmRemove: string | undefined;
	/** alef upgrade [organ...] */
	pmUpgrade: boolean;
	/** alef rollback [N] */
	pmRollback: number | undefined;
	/** alef history */
	pmHistory: boolean;
	/** alef audit */
	pmAudit: boolean;
	/** alef gc */
	pmGc: boolean;
	/** alef search <query> — discover organs on npm by keyword */
	pmSearch: string | undefined;
	/** alef sbom — SPDX JSON for installed organs */
	pmSbom: boolean;
	/** alef organ list — show installed organs from organs.yaml */
	pmOrganList: boolean;
	/** alef organ new <name> — scaffold a publishable organ package */
	pmOrganNew: string | undefined;
	/** alef export [path] — write alef-organs.lock to the project */
	pmExport: string | true | undefined;
	/** alef import [path] — restore organs from alef-organs.lock */
	pmImport: string | true | undefined;
	/** alef update — self-update the alef binary */
	pmSelfUpdate: boolean;

	// ── Introspection commands ──────────────────────────────────────────────
	listModels: boolean;
	showConfig: boolean;
	listDirectives: boolean;
	preflight: boolean;
	migrate: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-4-5@20250929";

const USAGE = `
Usage: alef [options] [prompt]

Options:
  -p, --print <prompt>   Send one message, print reply, exit
  --cwd <path>           Working directory (default: current directory)
  --model <id>           Model ID (default: ${DEFAULT_MODEL}, or ALEF_MODEL env var)
  --blueprint <path>     Load agent.yaml blueprint (configures organs and model)
  --list-tools           Print active tool names and exit (for diagnostics)
  --max-turns <n>        Max tool-call turns per run (default: 50, 0=unlimited)
  --thinking <level>     Enable extended thinking: minimal|low|medium|high|xhigh
  --resume [id]          Resume a previous session (id or 'last' for most recent)
  --list-sessions        Print all sessions for current --cwd and exit
  --no-tui               Use readline mode instead of TUI (also auto-set on non-TTY)
  --json                 Emit structured JSONL events (for TUI consumers)
  --debug                Debug mode: verbose logs in session JSONL (bus: "debug")
  --list-models          Print available models for active profile and exit
  --show-config          Print parsed config.yaml as JSON and exit
  --list-directives      Print enabled system prompt directive blocks and exit
  --preflight            Verify config, model, organs, tools, directives and exit
  --migrate              Import existing JSONL sessions into SQLite and exit
  -h, --help             Show this help

Package manager:
  install <organ>[@ver]  Install an organ (e.g. alef install organ-fs@0.1.2)
  remove  <organ>        Remove an organ
  upgrade [organ...]     Upgrade all or specific organs
  rollback [N]           Roll back to generation N (default: previous)
  history                List generation history
  audit                  Run npm audit on installed organs
  gc                     Remove old generations (keeps last 10)
  search  <query>        Discover organs on npm by keyword
  sbom                   Print SPDX JSON for all installed organs
  organ list             Show organs registered in organs.yaml
  organ new <name>       Scaffold a publishable organ package

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
		listOrgans: false,
		maxTurns: 50,
		debugSubcmd: undefined,
		debugSubcmdArgs: [],
		thinking: undefined,
		resume: undefined,
		listSessions: false,
		noTui: false,
		yolo: false,

		serve: undefined,
		daemon: false,
		attach: undefined,
		profile: undefined,
		debug: false,
		pmInstall: undefined,
		pmRemove: undefined,
		pmUpgrade: false,
		pmRollback: undefined,
		pmHistory: false,
		pmAudit: false,
		pmGc: false,
		pmSearch: undefined,
		pmSbom: false,
		pmOrganList: false,
		pmOrganNew: undefined,
		pmExport: undefined,
		pmImport: undefined,
		pmSelfUpdate: false,

		listModels: false,
		showConfig: false,
		listDirectives: false,
		preflight: false,
		migrate: false,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === "debug") {
			// alef debug <subcmd> [args...]
			args.debugSubcmd = argv[++i] ?? "session";
			args.debugSubcmdArgs = argv.slice(i + 1);
			break;
		}

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

		if (arg === "--list-organs") {
			args.listOrgans = true;
			i++;
			continue;
		}

		if (arg === "--list-models") {
			args.listModels = true;
			i++;
			continue;
		}

		if (arg === "--show-config") {
			args.showConfig = true;
			i++;
			continue;
		}

		if (arg === "--list-directives") {
			args.listDirectives = true;
			i++;
			continue;
		}

		if (arg === "--preflight") {
			args.preflight = true;
			i++;
			continue;
		}

		if (arg === "--migrate") {
			args.migrate = true;
			i++;
			continue;
		}

		if (arg === "--max-turns") {
			const n = Number.parseInt(argv[++i] ?? "50", 10);
			if (!Number.isNaN(n) && n >= 0) args.maxTurns = n;
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

		if (arg === "--yolo") {
			args.yolo = true;
			i++;
			continue;
		}

		if (arg === "--daemon") {
			args.daemon = true;
			args.noTui = true;
			args.serve = 0; // daemon implies --serve 0 (random port)
			i++;
			continue;
		}

		if (arg === "--attach") {
			args.attach = argv[++i] ?? "last";
			i++;
			continue;
		}

		if (arg === "--serve") {
			const n = Number.parseInt(argv[++i] ?? "3000", 10);
			args.serve = Number.isNaN(n) ? 3000 : n;
			i++;
			continue;
		}

		if (arg === "--profile") {
			args.profile = argv[++i] ?? undefined;
			i++;
			continue;
		}

		if (arg === "--json") {
			args.json = true;
			i++;
			continue;
		}

		if (arg === "--debug") {
			args.debug = true;
			i++;
			continue;
		}

		// Package manager subcommands
		if (arg === "install") {
			args.pmInstall = argv[++i] ?? "";
			i++;
			continue;
		}
		if (arg === "remove") {
			args.pmRemove = argv[++i] ?? "";
			i++;
			continue;
		}
		if (arg === "upgrade") {
			args.pmUpgrade = true;
			i++;
			continue;
		}
		if (arg === "rollback") {
			const n = parseInt(argv[i + 1] ?? "", 10);
			args.pmRollback = Number.isNaN(n) ? -1 : n; // -1 = previous
			if (!Number.isNaN(n)) i++;
			i++;
			continue;
		}
		if (arg === "history") {
			args.pmHistory = true;
			i++;
			continue;
		}
		if (arg === "audit") {
			args.pmAudit = true;
			i++;
			continue;
		}
		if (arg === "gc") {
			args.pmGc = true;
			i++;
			continue;
		}
		if (arg === "search") {
			args.pmSearch = argv[++i] ?? "";
			i++;
			continue;
		}
		if (arg === "sbom") {
			args.pmSbom = true;
			i++;
			continue;
		}
		if (arg === "organ") {
			const sub = argv[++i];
			if (sub === "list") {
				args.pmOrganList = true;
			} else if (sub === "new") {
				args.pmOrganNew = argv[++i] ?? "";
				i++;
			} else {
				console.error(`Unknown organ subcommand: ${sub ?? "(none)"}. Available: list, new`);
				process.exit(1);
			}
			i++;
			continue;
		}
		if (arg === "export") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				args.pmExport = next;
				i++;
			} else {
				args.pmExport = true;
			}
			i++;
			continue;
		}
		if (arg === "import") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				args.pmImport = next;
				i++;
			} else {
				args.pmImport = true;
			}
			i++;
			continue;
		}

		if (arg === "update") {
			args.pmSelfUpdate = true;
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
