/**
 * CLI argument parsing.
 *
 * Usage:
 *   alef                        — interactive mode, cwd = process.cwd()
 *   alef -p "prompt"            — print mode: send one message, print reply, exit
 *   alef --print "prompt"       — same
 *   alef --cwd /path/to/repo    — set working directory for fs and shell adapters
 *   alef --model claude-sonnet-4-5  — override default model
 *   alef --json                 — emit structured JSONL events instead of plain text
 *   alef --help                 — show usage
 */

/** Parsed CLI arguments controlling mode, model, adapters, and subcommands. */
export interface Args {
	/** Print mode: send one message and exit. */
	print: boolean;
	/** The prompt to send in print mode. */
	prompt: string;
	/** Working directory for FsAdapter and ShellAdapter. */
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
	 * When provided, adapters and model are configured from the blueprint.
	 * Hardcoded adapter defaults (fs + shell) are used otherwise.
	 */
	blueprint: string | undefined;
	/**
	 * Diagnostic: print one tool name per line and exit.
	 * Useful for verifying which tools a blueprint exposes.
	 */
	listTools: boolean;
	/**
	 * Diagnostic: print one adapter per line (name, labels, description) and exit.
	 * Useful for verifying which adapters are loaded and their metadata.
	 */
	listAdapters: boolean;
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
	logSubcmd: string | undefined;
	logArgs: string[];
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
	 * HTTP port for the Router adapter (HTTP/SSE bridge).
	 * When set, the router is mounted and the agent accepts requests on this port.
	 * External processes connect to GET /events for the SSE stream and
	 * POST /message to send user messages.
	 * Default: undefined (router disabled).
	 */
	serve: number | undefined;
	/** Host/interface for the HTTP router. Default: 127.0.0.1. */
	host: string | undefined;
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
	/** List running daemons from the registry. */
	listDaemons: boolean;
	/** Kill a running daemon by session ID. */
	killDaemon: string | undefined;
	/** Replay a recorded session with zero tokens. */
	replay: string | undefined;
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
	/** alef install <adapter>[@version] */
	pmInstall: string | undefined;
	/** alef remove <adapter> */
	pmRemove: string | undefined;
	/** alef upgrade [adapter...] */
	pmUpgrade: boolean;
	/** alef rollback [N] */
	pmRollback: number | undefined;
	/** alef history */
	pmHistory: boolean;
	/** alef audit */
	pmAudit: boolean;
	/** alef gc */
	pmGc: boolean;
	/** alef search <query> — discover adapters on npm by keyword */
	pmSearch: string | undefined;
	/** alef sbom — SPDX JSON for installed adapters */
	pmSbom: boolean;
	/** alef adapter list — show installed adapters from adapters.yaml */
	pmAdapterList: boolean;
	/** alef adapter new <name> — scaffold a publishable adapter package */
	pmAdapterNew: string | undefined;
	/** alef export [path] — write alef-adapters.lock to the project */
	pmExport: string | true | undefined;
	/** alef import [path] — restore adapters from alef-adapters.lock */
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

const USAGE = `
Usage: alef [options] [prompt]

Options:
  -p, --print <prompt>   Send one message, print reply, exit
  --cwd <path>           Working directory (default: current directory)
  --model <id>           Model ID (auto-detected from provider, or ALEF_MODEL env var)
  --blueprint <path>     Load agent.yaml blueprint (configures adapters and model)
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
  --preflight            Verify config, model, adapters, tools, directives and exit
  --migrate              Import existing JSONL sessions into SQLite and exit
  -h, --help             Show this help

Package manager:
  install <adapter>[@ver]  Install an adapter (e.g. alef install adapter-fs@0.1.2)
  remove  <adapter>        Remove an adapter
  upgrade [adapter...]     Upgrade all or specific adapters
  rollback [N]           Roll back to generation N (default: previous)
  history                List generation history
  audit                  Run npm audit on installed adapters
  gc                     Remove old generations (keeps last 10)
  search  <query>        Discover adapters on npm by keyword
  sbom                   Print SPDX JSON for all installed adapters
  adapter list           Show adapters registered in adapters.yaml
  adapter new <name>     Scaffold a publishable adapter package

Examples:
  alef                                 # interactive mode
  alef -p "What files are in src/?"   # print mode
  alef --cwd ~/project -p "Audit src/auth.ts"
  alef --blueprint agent.yaml -p "Fix the bug"  # blueprint-configured run
  alef --json -p "Fix the bug"        # machine-readable output
`.trim();

// ── Named constants ─────────────────────────────────────────────────────────
/** Default maximum tool-call turns before the agent stops. */
const DEFAULT_MAX_TURNS = 50;
/** Default HTTP port for the --serve flag. */
const DEFAULT_SERVE_PORT = 3000;
/** Rollback sentinel: roll back to the previous generation. */
const ROLLBACK_PREVIOUS = -1;

// ── Defaults factory ────────────────────────────────────────────────────────
/** Construct a fresh Args struct with default values. */
function defaultArgs(): Args {
	return {
		print: false,
		prompt: "",
		cwd: process.cwd(),
		modelId: process.env.ALEF_MODEL,
		json: false,
		blueprint: undefined,
		listTools: false,
		listAdapters: false,
		maxTurns: DEFAULT_MAX_TURNS,
		debugSubcmd: undefined,
		debugSubcmdArgs: [],
		logSubcmd: undefined,
		logArgs: [],
		thinking: undefined,
		resume: undefined,
		listSessions: false,
		noTui: false,
		yolo: false,

		serve: undefined,
		host: undefined,
		daemon: false,
		attach: undefined,
		listDaemons: false,
		killDaemon: undefined,
		replay: undefined,
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
		pmAdapterList: false,
		pmAdapterNew: undefined,
		pmExport: undefined,
		pmImport: undefined,
		pmSelfUpdate: false,

		listModels: false,
		showConfig: false,
		listDirectives: false,
		preflight: false,
		migrate: false,
	};
}

// Flag group parsers — return extra argv consumed (0 = flag only, 1 = flag + value), or undefined if unrecognized.

/** -p/--print, --json, --no-tui, --daemon, --attach, --serve, --host */
function parseModeFlags(arg: string, argv: string[], i: number, args: Args): number | undefined {
	if (arg === "-p" || arg === "--print") {
		args.print = true;
		args.prompt = argv[i + 1] ?? "";
		return 1;
	}
	if (arg === "--json") {
		args.json = true;
		return 0;
	}
	if (arg === "--no-tui") {
		args.noTui = true;
		return 0;
	}
	if (arg === "--daemon") {
		args.daemon = true;
		args.noTui = true;
		args.serve = 0; // daemon implies --serve 0 (random port)
		return 0;
	}
	if (arg === "--attach") {
		args.attach = argv[i + 1] ?? "last";
		return 1;
	}
	if (arg === "--serve") {
		const n = Number.parseInt(argv[i + 1] ?? String(DEFAULT_SERVE_PORT), 10);
		args.serve = Number.isNaN(n) ? DEFAULT_SERVE_PORT : n;
		return 1;
	}
	if (arg === "--host") {
		args.host = argv[i + 1] ?? "127.0.0.1";
		return 1;
	}
	return undefined;
}

/** --resume, --list-sessions, --replay, --kill, --list/ls (daemons) */
function parseSessionFlags(arg: string, argv: string[], i: number, args: Args): number | undefined {
	if (arg === "--resume") {
		// Optional value: --resume <id> or bare --resume (= last)
		const next = argv[i + 1];
		if (next && !next.startsWith("-")) {
			args.resume = next;
			return 1;
		}
		args.resume = "last";
		return 0;
	}
	if (arg === "--list-sessions") {
		args.listSessions = true;
		return 0;
	}
	if (arg === "--replay" || arg === "replay") {
		args.replay = argv[i + 1] ?? "last";
		return 1;
	}
	if (arg === "--kill" || arg === "kill") {
		args.killDaemon = argv[i + 1] ?? "";
		return 1;
	}
	if (arg === "--list" || arg === "ls") {
		args.listDaemons = true;
		return 0;
	}
	return undefined;
}

/** --model, --thinking, --blueprint, --profile, --max-turns */
function parseModelFlags(arg: string, argv: string[], i: number, args: Args): number | undefined {
	if (arg === "--model") {
		args.modelId = argv[i + 1] ?? args.modelId;
		return 1;
	}
	if (arg === "--thinking") {
		args.thinking = argv[i + 1] ?? undefined;
		return 1;
	}
	if (arg === "--blueprint") {
		args.blueprint = argv[i + 1] ?? undefined;
		return 1;
	}
	if (arg === "--profile") {
		args.profile = argv[i + 1] ?? undefined;
		return 1;
	}
	if (arg === "--max-turns") {
		const n = Number.parseInt(argv[i + 1] ?? String(DEFAULT_MAX_TURNS), 10);
		if (!Number.isNaN(n) && n >= 0) args.maxTurns = n;
		return 1;
	}
	return undefined;
}

/** -h/--help, --list-tools, --list-adapters, --list-models, --show-config,
 *  --list-directives, --preflight, --migrate, --debug */
function parseInfoFlags(arg: string, _argv: string[], _i: number, args: Args): number | undefined {
	if (arg === "-h" || arg === "--help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (arg === "--list-tools") {
		args.listTools = true;
		return 0;
	}
	if (arg === "--list-adapters") {
		args.listAdapters = true;
		return 0;
	}
	if (arg === "--list-models") {
		args.listModels = true;
		return 0;
	}
	if (arg === "--show-config") {
		args.showConfig = true;
		return 0;
	}
	if (arg === "--list-directives") {
		args.listDirectives = true;
		return 0;
	}
	if (arg === "--preflight") {
		args.preflight = true;
		return 0;
	}
	if (arg === "--migrate") {
		args.migrate = true;
		return 0;
	}
	if (arg === "--debug") {
		args.debug = true;
		return 0;
	}
	return undefined;
}

/** install, remove, upgrade, rollback, history, audit, gc, search, sbom, adapter,
 *  export, import, update */
function parsePmFlags(arg: string, argv: string[], i: number, args: Args): number | undefined {
	if (arg === "install") {
		args.pmInstall = argv[i + 1] ?? "";
		return 1;
	}
	if (arg === "remove") {
		args.pmRemove = argv[i + 1] ?? "";
		return 1;
	}
	if (arg === "upgrade") {
		args.pmUpgrade = true;
		return 0;
	}
	if (arg === "rollback") {
		const n = parseInt(argv[i + 1] ?? "", 10);
		args.pmRollback = Number.isNaN(n) ? ROLLBACK_PREVIOUS : n;
		if (!Number.isNaN(n)) return 1;
		return 0;
	}
	if (arg === "history") {
		args.pmHistory = true;
		return 0;
	}
	if (arg === "audit") {
		args.pmAudit = true;
		return 0;
	}
	if (arg === "gc") {
		args.pmGc = true;
		return 0;
	}
	if (arg === "search") {
		args.pmSearch = argv[i + 1] ?? "";
		return 1;
	}
	if (arg === "sbom") {
		args.pmSbom = true;
		return 0;
	}
	if (arg === "adapter") {
		const sub = argv[i + 1];
		if (sub === "list") {
			args.pmAdapterList = true;
			return 1;
		}
		if (sub === "new") {
			args.pmAdapterNew = argv[i + 2] ?? "";
			return 2;
		}
		console.error(`Unknown adapter subcommand: ${sub}. Available: list, new`);
		process.exit(1);
	}
	if (arg === "export") {
		const next = argv[i + 1];
		if (next && !next.startsWith("-")) {
			args.pmExport = next;
			return 1;
		}
		args.pmExport = true;
		return 0;
	}
	if (arg === "import") {
		const next = argv[i + 1];
		if (next && !next.startsWith("-")) {
			args.pmImport = next;
			return 1;
		}
		args.pmImport = true;
		return 0;
	}
	if (arg === "update") {
		args.pmSelfUpdate = true;
		return 0;
	}
	return undefined;
}

/** --cwd, --yolo, debug (subcmd), log (subcmd) */
function parseMiscFlags(arg: string, argv: string[], i: number, args: Args): number | undefined {
	if (arg === "--cwd") {
		args.cwd = argv[i + 1] ?? process.cwd();
		return 1;
	}
	if (arg === "--yolo") {
		args.yolo = true;
		return 0;
	}
	if (arg === "debug") {
		// alef debug <subcmd> [args...]
		args.debugSubcmd = argv[i + 1] ?? "session";
		args.debugSubcmdArgs = argv.slice(i + 2);
		return Infinity; // consume all remaining args
	}
	if (arg === "log") {
		args.logSubcmd = argv[i + 1] ?? "sessions";
		args.logArgs = argv.slice(i + 2);
		return Infinity; // consume all remaining args
	}
	return undefined;
}

/** Parse process.argv into a typed Args struct, exiting on --help or unknown flags. */
export function parseArgs(argv: string[]): Args {
	const args = defaultArgs();

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		const consumed =
			parseModeFlags(arg, argv, i, args) ??
			parseSessionFlags(arg, argv, i, args) ??
			parseModelFlags(arg, argv, i, args) ??
			parseInfoFlags(arg, argv, i, args) ??
			parsePmFlags(arg, argv, i, args) ??
			parseMiscFlags(arg, argv, i, args);

		if (consumed !== undefined) {
			i += 1 + consumed;
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
