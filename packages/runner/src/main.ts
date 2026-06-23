#!/usr/bin/env tsx

import "@dpopsuev/alef-coding-agent";
import "@dpopsuev/alef-factory-agent";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "./args.js";
import { dispatchCliOp } from "./cli-ops.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";

import { initYamlBlueprints } from "./init-yaml-blueprints.js";
import { loadAdapters } from "./load-adapters.js";
import { createLocalSession } from "./local-session.js";
import { createRunnerLogger } from "./logger.js";
import { resolveStartupModel } from "./model/index.js";
import { setupOTel } from "./otel.js";
import { runAgent } from "./run-agent.js";
import { handleSelfUpdate, runPmCommand } from "./run-pm-command.js";
import { loadSession } from "./session-lifecycle/index.js";
import { setupSupervisorIpc } from "./setup-supervisor-ipc.js";
import type { DaemonEntry } from "./strategies/remote-session.js";
import { RemoteSession } from "./strategies/remote-session.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { loadTheme } from "./theme-loader.js";

import { ensureDirectories } from "./xdg-paths.js";

process.title = "alef";
ensureDirectories();
const cfg = loadConfig();
setupOTel();

// Auto-register YAML blueprints from config directories
await initYamlBlueprints();

const args = parseArgs(process.argv.slice(2));

await runPmCommand(args);
await handleSelfUpdate(args);

if (args.migrate) {
	const { getDatabase, migrateJsonlToSqlite } = await import("@dpopsuev/alef-storage");
	const db = await getDatabase();
	const result = await migrateJsonlToSqlite(db);
	console.log(
		`Migrated ${result.sessions} sessions (${result.events} events, ${result.discourse} discourse posts, ${result.auth} auth keys)`,
	);
	if (result.skipped > 0) console.log(`Skipped ${result.skipped} (empty or malformed)`);
	process.exit(0);
}

// Handle debug subcommands before any session/agent setup.
if (args.debugSubcmd) {
	switch (args.debugSubcmd) {
		case "session":
			await runDebugSession(args.debugSubcmdArgs, args.cwd);
			break;
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session");
			process.exit(1);
	}
	process.exit(0);
}

// --attach: connect to a running daemon and run TUI against it.
if (args.attach !== undefined) {
	const daemonPath = join(homedir(), ".alef", "daemon.json");
	let entry: DaemonEntry;
	try {
		entry = JSON.parse(readFileSync(daemonPath, "utf-8")) as DaemonEntry;
	} catch {
		console.error("No running daemon found. Start one with: alef --daemon");
		process.exit(1);
	}
	const remoteSession = new RemoteSession(entry);
	loadTheme(
		undefined,
		cfg.theme?.name,
		cfg.theme?.colors,
		await detectDark(cfg.theme?.background_opacity ?? readAlacrittyOpacity()),
		[],
	);
	await runAgent({
		args: { ...args, noTui: false },
		resolvedModelDisplay: `remote:${entry.port}`,
		sessionId: entry.sessionId,
		contextWindow: remoteSession.state.contextWindow,
		getModel: () => remoteSession.getModel(),
		setModel: (id) => remoteSession.setModel(id),
		getThinking: () => remoteSession.getThinking(),
		setThinking: (level) => remoteSession.setThinking(level),
		setLLMAbortController: (ctrl) => remoteSession.setTurnController(ctrl),
		reloadOrgan: async (_name: string, _path: string) => {},
		getDirectiveAdapter: () => undefined,
		session: remoteSession,
	});
	process.exit(0);
}

// Configure storage backend from config.yaml (local or Turso cloud).
if (cfg.storage) {
	const { configureStorage } = await import("@dpopsuev/alef-storage");
	configureStorage({
		backend: cfg.storage.backend,
		tursoUrl: cfg.storage.turso_url,
		tursoToken: cfg.storage.turso_token,
		syncInterval: cfg.storage.sync_interval,
	});
}

const willUseTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;
if (willUseTui) {
	process.stderr.write = (
		_chunk: string | Uint8Array,
		encOrCb?: BufferEncoding | ((err?: Error | null) => void),
		cb?: (err?: Error | null) => void,
	): boolean => {
		const callback = typeof encOrCb === "function" ? encOrCb : cb;
		callback?.();
		return true;
	};
}
const log = createRunnerLogger(willUseTui, args.debug);
const session = await loadSession(args, willUseTui);

// Route debug events into the session JSONL — unified transcript.
const { debugLog, initSessionSink } = await import("@dpopsuev/alef-kernel");
initSessionSink((record) => {
	void session.append({
		bus: "debug" as "internal",
		type: typeof record.type === "string" ? record.type : "debug",
		correlationId: "debug",
		payload: record,
		timestamp: Date.now(),
	});
});

debugLog("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui, sessionId: session.id });

// Initialize local embedding model for vector recall (lazy-loads on first embed).
import("@dpopsuev/alef-storage")
	.then(({ setEmbedder, LocalEmbedder }) => setEmbedder(new LocalEmbedder()))
	.catch(() => {});

const sessionDir = dirname(session.path);
const loaded = await loadAdapters(args, cfg, log, sessionDir);
const { blueprintUpgradePolicy, blueprintPath } = loaded;

const {
	session: localSession,
	resolvedModelDisplay,
	humanAddress,
	agentAddress,
	actorRoutes,
} = await createLocalSession(args, cfg, log, session, loaded, resolveStartupModel(args, loaded.blueprintModelId, cfg));

if (dispatchCliOp(args, localSession)) {
	// CLI op dispatched — it calls process.exit() internally
}
const opacity = cfg.theme?.background_opacity ?? readAlacrittyOpacity();
const [isDark, terminalPalette] = await Promise.all([
	detectDark(opacity),
	queryPalette(Array.from({ length: 10 }, (_, i) => i + 5)),
]);
loadTheme(
	blueprintPath ? new URL("..", `file://${blueprintPath}`).pathname : undefined,
	cfg.theme?.name,
	cfg.theme?.colors,
	isDark,
	terminalPalette,
);

setupSupervisorIpc(blueprintUpgradePolicy);

await runAgent({
	args,
	resolvedModelDisplay,
	sessionId: session.id,
	contextWindow: localSession.state.contextWindow,
	getModel: () => localSession.getModel(),
	setModel: (id) => localSession.setModel(id),
	getThinking: () => localSession.getThinking(),
	setThinking: (level) => localSession.setThinking(level),
	setLLMAbortController: (ctrl) => localSession.setTurnController(ctrl),
	reloadOrgan: async (name, path) => localSession.reloadOrgan?.(name, path),
	getDirectiveAdapter: () => localSession.getDirective?.(),
	session: localSession,
	store: session,
	humanAddress,
	agentAddress,
	actorRoutes,
});

debugLog("process.exit");
process.exit(0);
