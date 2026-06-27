#!/usr/bin/env tsx

/**
 * Supervisor-based entrypoint.
 *
 * Phase 1: Pure setup (config, OTel, args)
 * Phase 2: CLI dispatch (early-exit commands)
 * Phase 3: Supervisor boot (storage → agent → TUI)
 */

import "@dpopsuev/alef-coding-agent";
import "@dpopsuev/alef-factory-agent";

import { dirname } from "node:path";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { createStorageDescriptor, type StorageService } from "@dpopsuev/alef-storage/service";
import { createSchedulerDescriptor } from "@dpopsuev/alef-supervisor/scheduler";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import updateNotifier from "update-notifier";
import { type AgentService, createAgentServiceDescriptor } from "./agent-service.js";
import { parseArgs } from "./args.js";
import { BUILD_INFO } from "./build-info.js";
import { loadAdapters } from "./cli/load-adapters.js";
import { buildIdentityContext } from "./cli/local-session.js";
import { pickSession } from "./cli/session-picker.js";
import { loadTheme } from "./cli/theme-loader.js";
import { dispatchCliOp } from "./cli-ops.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { initYamlBlueprints } from "./init-yaml-blueprints.js";
import { createRunnerLogger } from "./logger.js";
import { resolveStartupModel, setModelConfigProvider } from "./model/index.js";
import { setupOTel } from "./otel.js";
import { handleSelfUpdate, runPmCommand } from "./run-pm-command.js";
import { loadSession } from "./session-lifecycle/index.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { createTuiServiceDescriptor } from "./tui-service.js";
import { ensureDirectories } from "./xdg-paths.js";

// ---------------------------------------------------------------------------
// Phase 1: Pure setup
// ---------------------------------------------------------------------------

process.title = "alef";
updateNotifier({ pkg: { name: "@dpopsuev/alef", version: BUILD_INFO.version } }).notify();
ensureDirectories();

const cfg = loadConfig();
setModelConfigProvider(() => cfg);
setupOTel();
await initYamlBlueprints();

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Phase 2: CLI dispatch — early exit (no Supervisor)
// ---------------------------------------------------------------------------

await runPmCommand(args);
await handleSelfUpdate(args);

const supervisor = new Supervisor();
supervisor.register(createStorageDescriptor(cfg.storage));
supervisor.register(createSchedulerDescriptor());

async function getStorage(): Promise<StorageFactory> {
	await supervisor.startAll({ cwd: args.cwd });
	const svc = supervisor.get("storage");
	if (!svc) throw new Error("Storage service failed to start");
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- StorageService extends ManagedService with factory field
	return (svc as StorageService).factory;
}

if (args.debugSubcmd) {
	const storage = await getStorage();
	switch (args.debugSubcmd) {
		case "session":
			await runDebugSession(args.debugSubcmdArgs, args.cwd, storage.sessions);
			break;
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session");
			process.exit(1);
	}
	await supervisor.stopAll();
	process.exit(0);
}

if (args.replay !== undefined) {
	const { runReplay } = await import("./cli/replay.js");
	await runReplay(args.cwd, args.replay);
	process.exit(0);
}

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
	await supervisor.stopAll();
	process.exit(0);
}

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
	await supervisor.stopAll();
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
	const { RemoteSession } = await import("./strategies/remote-session.js");
	const { runAgent } = await import("./run-agent.js");
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
	await supervisor.stopAll();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Phase 3: Supervisor boot — agent + TUI as services
// ---------------------------------------------------------------------------

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

import { setAuthStore, warmAuthCache } from "./auth.js";

setAuthStore(storage.authStore());
await warmAuthCache();

import type { SessionPreviewProvider } from "@dpopsuev/alef-storage";

const preview: SessionPreviewProvider | undefined =
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- duck-typed at boundary
	"sessionPreview" in storage ? (storage as { sessionPreview(): SessionPreviewProvider }).sessionPreview() : undefined;
const session = await loadSession(args, storage.sessions, willUseTui, pickSession, preview);

const { traceEvent, initSessionSink } = await import("@dpopsuev/alef-kernel/log");
initSessionSink((record) => {
	void session.append({
		bus: "internal",
		type: typeof record.type === "string" ? record.type : "debug",
		correlationId: "debug",
		payload: record,
		timestamp: Date.now(),
	});
});

traceEvent("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui, sessionId: session.id });

Promise.all([import("@dpopsuev/alef-embedding"), import("@dpopsuev/alef-storage/sqlite/session")])
	.then(([{ setEmbedder, LocalEmbedder, queueEmbedding }, { setEmbeddingCallback }]) => {
		setEmbedder(new LocalEmbedder());
		setEmbeddingCallback(queueEmbedding);
	})
	.catch((err: unknown) => {
		log.warn({ error: String(err) }, "embedder init failed, vector recall disabled");
	});

// Boot-time inputs for agent service
const sessionDir = dirname(session.path);
const loaded = await loadAdapters(args, cfg, log, sessionDir);
const model = resolveStartupModel(args, loaded.blueprintModelId, cfg);
const identity = buildIdentityContext(session);

// Register agent service — wraps createLocalSession
supervisor.register(
	createAgentServiceDescriptor({
		args,
		cfg,
		log,
		store: session,
		loaded,
		model,
		storage,
		identity,
	}),
);

// Register TUI service — wraps selectViewMode + viewer.run
supervisor.register(createTuiServiceDescriptor({ args, store: session }));

// Theme
const opacity = cfg.theme?.background_opacity ?? readAlacrittyOpacity();
const [isDark, terminalPalette] = await Promise.all([
	detectDark(opacity),
	queryPalette(Array.from({ length: 10 }, (_, i) => i + 5)),
]);
loadTheme(
	loaded.blueprintPath ? new URL("..", `file://${loaded.blueprintPath}`).pathname : undefined,
	cfg.theme?.name,
	cfg.theme?.colors,
	isDark,
	terminalPalette,
);

// Start agent + TUI (topo-sorted: storage already running, agent first, TUI after)
await supervisor.startAll({ cwd: args.cwd });

const agentRaw = supervisor.get("agent");
if (agentRaw && "sessionHandle" in agentRaw) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'sessionHandle' in check
	const agentSvc = agentRaw as AgentService;
	dispatchCliOp(args, agentSvc.sessionHandle);
}

// Signal handlers — Supervisor stops everything
process.once("SIGTERM", () => {
	void supervisor.stopAll().then(() => process.exit(0));
});
process.once("SIGINT", () => {
	void supervisor.stopAll().then(() => process.exit(0));
});

// TUI service is running (started by startAll). Wait for it to finish.
// In daemon mode, TUI service picks headless mode (blocks forever).
// The process stays alive until SIGTERM or the TUI exits.
await new Promise<void>(() => {});
