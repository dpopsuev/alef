#!/usr/bin/env tsx

import "@dpopsuev/alef-coding-agent";
import "@dpopsuev/alef-factory-agent";

import { dirname } from "node:path";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { AgentRuntime } from "../agent-runtime.js";
import { parseArgs } from "../args.js";
import { dispatchCliOp } from "../cli-ops.js";
import { loadConfig } from "../config.js";
import { runDebugSession } from "../debug-session.js";
import { initYamlBlueprints } from "../init-yaml-blueprints.js";
import { createRunnerLogger } from "../logger.js";
import { resolveStartupModel, setModelConfigProvider } from "../model/index.js";
import { setupOTel } from "../otel.js";
import { runAgent } from "../run-agent.js";
import { handleSelfUpdate, runPmCommand } from "../run-pm-command.js";
import { loadSession } from "../session-lifecycle/index.js";
import { setupSupervisorIpc } from "../setup-supervisor-ipc.js";
import { RemoteSession } from "../strategies/remote-session.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "../terminal-bg.js";
import { ensureDirectories } from "../xdg-paths.js";
import { loadAdapters } from "./load-adapters.js";
import { pickSession } from "./session-picker.js";
import { loadTheme } from "./theme-loader.js";

process.title = "alef";

import updateNotifier from "update-notifier";
import { BUILD_INFO } from "../build-info.js";

updateNotifier({ pkg: { name: "@dpopsuev/alef", version: BUILD_INFO.version } }).notify();

ensureDirectories();
const cfg = loadConfig();
setModelConfigProvider(() => cfg);
setupOTel();

// Auto-register YAML blueprints from config directories
await initYamlBlueprints();

const args = parseArgs(process.argv.slice(2));

await runPmCommand(args);
await handleSelfUpdate(args);

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

let _storage: StorageFactory | undefined;
async function getStorage(): Promise<StorageFactory> {
	if (!_storage) {
		const { getDatabase, SqliteStorageFactory } = await import("@dpopsuev/alef-storage");
		const db = await getDatabase();
		_storage = new SqliteStorageFactory(db);
	}
	return _storage;
}

// Handle debug subcommands before any session/agent setup.
if (args.debugSubcmd) {
	switch (args.debugSubcmd) {
		case "session":
			await runDebugSession(args.debugSubcmdArgs, args.cwd, (await getStorage()).sessions);
			break;
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session");
			process.exit(1);
	}
	process.exit(0);
}

if (args.replay !== undefined) {
	const { runReplay } = await import("./replay.js");
	await runReplay(args.cwd, args.replay);
	process.exit(0);
}

// --list: show running daemons
if (args.listDaemons) {
	const storage = await getStorage();
	const store = storage.daemonRegistry();
	await store.prune();
	const entries = await store.list();
	if (entries.length === 0) {
		console.log("No running daemons.");
	} else {
		for (const e of entries) {
			const age = Math.round((Date.now() - e.startedAt) / 1000);
			console.log(`  ${e.sessionId}  pid=${e.pid}  port=${e.port}  cwd=${e.cwd}  age=${age}s`);
		}
	}
	process.exit(0);
}

// --kill <sessionId>: stop a running daemon
if (args.killDaemon !== undefined) {
	const storage = await getStorage();
	const store = storage.daemonRegistry();
	const entry = await store.get(args.killDaemon);
	if (!entry) {
		console.error(`No daemon found with session ID: ${args.killDaemon}`);
		process.exit(1);
	}
	try {
		process.kill(entry.pid, "SIGTERM");
		console.log(`Sent SIGTERM to daemon ${entry.sessionId} (pid ${entry.pid})`);
	} catch {
		console.error(`Daemon ${entry.sessionId} (pid ${entry.pid}) is not running.`);
	}
	await store.unregister(entry.sessionId);
	process.exit(0);
}

if (args.attach !== undefined) {
	const storage = await getStorage();
	const daemonRegistry = storage.daemonRegistry();
	await daemonRegistry.prune();
	const entry =
		args.attach === "last"
			? await daemonRegistry.findLatest()
			: ((await daemonRegistry.get(args.attach)) ?? (await daemonRegistry.findByCwd(args.attach)));
	if (!entry) {
		console.error("No running daemon found. Start one with: alef --daemon");
		process.exit(1);
	}
	const remoteSession = new RemoteSession(entry);
	await remoteSession.ready();
	loadTheme(
		undefined,
		cfg.theme?.name,
		cfg.theme?.colors,
		await detectDark(cfg.theme?.background_opacity ?? readAlacrittyOpacity()),
		[],
	);
	await runAgent({
		args: { ...args, noTui: false },
		resolvedModelDisplay: remoteSession.getModel(),
		sessionId: entry.sessionId,
		contextWindow: remoteSession.state.contextWindow,
		getModel: () => remoteSession.getModel(),
		setModel: (id) => remoteSession.setModel(id),
		getThinking: () => remoteSession.getThinking(),
		setThinking: (level) => remoteSession.setThinking(level),
		setLLMAbortController: (ctrl) => remoteSession.setTurnController(ctrl),
		reloadAdapter: async (name: string, path: string) => remoteSession.reloadAdapter(name, path),
		getDirectiveAdapter: () => undefined,
		session: remoteSession,
	});
	process.exit(0);
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
const storage = await getStorage();

import { setAuthStore, warmAuthCache } from "../auth.js";

setAuthStore(storage.authStore());
await warmAuthCache();

import type { SessionPreviewProvider } from "@dpopsuev/alef-storage";

const preview: SessionPreviewProvider | undefined =
	"sessionPreview" in storage ? (storage as { sessionPreview(): SessionPreviewProvider }).sessionPreview() : undefined;
const session = await loadSession(args, storage.sessions, willUseTui, pickSession, preview);

// Route debug events into the session JSONL — unified transcript.
const { traceEvent, initSessionSink } = await import("@dpopsuev/alef-kernel");
initSessionSink((record) => {
	void session.append({
		bus: "debug" as "internal",
		type: typeof record.type === "string" ? record.type : "debug",
		correlationId: "debug",
		payload: record,
		timestamp: Date.now(),
	});
});

traceEvent("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui, sessionId: session.id });
process.send?.({ type: "session", sessionId: session.id });

// Initialize local embedding model for vector recall (lazy-loads on first embed).
Promise.all([import("@dpopsuev/alef-embedding"), import("@dpopsuev/alef-storage")])
	.then(([{ setEmbedder, LocalEmbedder, queueEmbedding }, { setEmbeddingCallback }]) => {
		setEmbedder(new LocalEmbedder());
		setEmbeddingCallback(queueEmbedding);
	})
	.catch((err: unknown) => {
		log.warn({ error: String(err) }, "embedder init failed, vector recall disabled");
	});

const sessionDir = dirname(session.path);
const loaded = await loadAdapters(args, cfg, log, sessionDir);
const { blueprintUpgradePolicy, blueprintPath } = loaded;

const runtime = new AgentRuntime({ storage });
const {
	session: localSession,
	resolvedModelDisplay,
	humanAddress,
	agentAddress,
	identity: { actorRoutes },
} = await runtime.startSession(
	args,
	cfg,
	log,
	session,
	loaded,
	resolveStartupModel(args, loaded.blueprintModelId, cfg),
);

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
process.send?.({ type: "ready" });

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
	reloadAdapter: async (name, path) => localSession.reloadAdapter?.(name, path),
	getDirectiveAdapter: () => localSession.getDirective?.(),
	session: localSession,
	store: session,
	humanAddress,
	agentAddress,
	actorRoutes,
});

traceEvent("process.exit");
process.exit(0);
