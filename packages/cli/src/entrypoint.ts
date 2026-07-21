#!/usr/bin/env tsx

/**
 * Foundry-backed entrypoint.
 *
 * Phase 1: Pure setup (config, OTel, args)
 * Phase 2: CLI dispatch (early-exit commands)
 * Phase 3: Foundry boot (storage → agent → TUI)
 */

import "@dpopsuev/alef-coding-agent";
import "@dpopsuev/alef-factory-agent";

import { dirname } from "node:path";
import { resolveStartupModel, setModelConfigProvider } from "@dpopsuev/alef-agent/model";
import { detectEnvironment } from "@dpopsuev/alef-supervisor/environment";
import { isTermDark } from "is-term-dark";
import updateNotifier from "update-notifier";
import { loadAdapters } from "./boot/adapters.js";
import { parseArgs } from "./boot/args.js";
import { BUILD_INFO } from "./boot/build-info.js";
import { loadConfig, resolveDaemonConfig } from "./boot/config.js";
import { deriveDiscussionRef } from "./boot/discussion.js";
import { createCliFoundryRuntime } from "./boot/foundry-runtime.js";
import { initPmBlueprints } from "./boot/init-pm-blueprints.js";
import { createRunnerLogger } from "./boot/logger.js";
import { preferIpv4IfUnreachable } from "./boot/network.js";
import { setupOTel } from "./boot/otel.js";
import type { SessionHandle } from "./boot/session.js";
import { buildIdentityContext, loadSession } from "./boot/session.js";
import type { SessionService } from "./boot/session-service.js";
import { setupSupervisorIpc } from "./boot/supervisor-ipc.js";
import { ensureDirectories } from "./boot/xdg-paths.js";
import { loadTheme, queryPalette, TERMINAL_PALETTE_SLOTS } from "./client/theme.js";
import { dispatchCliOp } from "./debug/cli-ops.js";
import { runDebugSession } from "./debug/debug-session.js";
import { handleSelfUpdate, runPmCommand } from "./pkg/run-pm-command.js";

// ---------------------------------------------------------------------------
// Phase 1: Pure setup
// ---------------------------------------------------------------------------

import { createExitRestartStrategy, setRestartStrategy } from "./boot/reboot-port.js";

process.title = "alef";
setupSupervisorIpc();
setRestartStrategy(createExitRestartStrategy());
await preferIpv4IfUnreachable();
updateNotifier({ pkg: { name: "@dpopsuev/alef", version: BUILD_INFO.version } }).notify();
ensureDirectories();

const cfg = loadConfig();
setModelConfigProvider(() => cfg);
setupOTel();
initPmBlueprints();

const args = parseArgs(process.argv.slice(2));

if (args.daemon && cfg.daemon) {
	args.serve ??= cfg.daemon.port ?? 0;
	args.host ??= cfg.daemon.host;
}

if (args.host === "0.0.0.0") {
	process.stderr.write(
		"[alef] WARNING: binding to 0.0.0.0 exposes the daemon to the network. Consider enabling auth.\n",
	);
}

// ---------------------------------------------------------------------------
// Phase 2: CLI dispatch — early exit (no Supervisor)
// ---------------------------------------------------------------------------

await runPmCommand(args);
await handleSelfUpdate(args);

const runtime = createCliFoundryRuntime({ cwd: args.cwd, storage: cfg.storage });

if (args.debugSubcmd) {
	switch (args.debugSubcmd) {
		case "session": {
			const storage = await runtime.getStorage();
			await runDebugSession(args.debugSubcmdArgs, args.cwd, storage.sessions);
			await runtime.stop();
			break;
		}
		case "tui": {
			const { runDebugTui } = await import("./debug/debug-tui.js");
			await runDebugTui(args.debugSubcmdArgs, args.cwd);
			break;
		}
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session, tui");
			process.exit(1);
	}
	process.exit(0);
}

if (args.logSubcmd) {
	const { runLogCommand } = await import("./debug/log-cli.js");
	await runLogCommand(args.logSubcmd, args.logArgs);
	process.exit(0);
}

if (args.replay !== undefined) {
	const { runReplay } = await import("./boot/replay.js");
	await runReplay(args.cwd, args.replay);
	process.exit(0);
}

if (args.listDaemons) {
	const storage = await runtime.getStorage();
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
	await runtime.stop();
	process.exit(0);
}

if (args.killDaemon !== undefined) {
	const storage = await runtime.getStorage();
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
	await runtime.stop();
	process.exit(0);
}

if (args.attach !== undefined) {
	const storage = await runtime.getStorage();
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
	const { RemoteSession } = await import("./boot/remote.js");
	const { runAgent } = await import("./boot/runner.js");
	const remoteSession = new RemoteSession(entry);
	await remoteSession.ready();
	loadTheme(undefined, cfg.theme?.name, cfg.theme?.colors, (await isTermDark()) ?? true, []);
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
	await runtime.stop();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Phase 3: Foundry boot — agent + TUI as services
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

import { setModelLogger } from "@dpopsuev/alef-agent/model";

setModelLogger({ warn: (msg) => log.warn(msg), error: (msg) => log.error(msg) });

const env = detectEnvironment(args.cwd);
log.info({ mode: env.mode, warmReboot: env.canWarmReboot }, "Runtime environment");

const storage = await runtime.getStorage();

import { upgradeToSqliteExporter } from "./boot/otel.js";

await upgradeToSqliteExporter();

import { setAuthStore, warmAuthCache } from "./boot/auth.js";

setAuthStore(storage.authStore());
await warmAuthCache();

// ---------------------------------------------------------------------------
// TUI path: delegate to Bootstrapper for unified boot
// ---------------------------------------------------------------------------
if (willUseTui) {
	const { bootWithBootstrapper } = await import("./boot/boot-tui.js");
	await bootWithBootstrapper({ args, cfg, log, runtime, storage });
	await runtime.stop();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Non-TUI path: sequential boot (print, json, serve, daemon)
// ---------------------------------------------------------------------------
import type { SessionPreviewProvider } from "@dpopsuev/alef-storage";

const preview: SessionPreviewProvider = storage.sessionPreview();
const session = await loadSession(args, storage.sessions, false, undefined, preview);
process.env.ALEF_SESSION_ID = session.id;
const identity = buildIdentityContext(session);
const discussion = deriveDiscussionRef(session, args.cwd);

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

// Boot manifest is emitted after adapters/model resolve -- see boot:manifest below.

Promise.all([import("@dpopsuev/alef-embedding"), import("@dpopsuev/alef-storage/sqlite/session")])
	.then(([{ setEmbedder, LocalEmbedder, queueEmbedding }, { setEmbeddingCallback }]) => {
		setEmbedder(new LocalEmbedder());
		setEmbeddingCallback(queueEmbedding);
	})
	.catch((err: unknown) => {
		log.warn({ error: String(err) }, "embedder init failed, vector recall disabled");
	});

// Boot-time inputs
const sessionDir = dirname(session.path);
const loaded = await loadAdapters(args, cfg, log, sessionDir, {
	resolveService: runtime.resolveService,
	actorAddress: identity.agentActor.address,
	sessionId: session.id,
	discussion,
});
const model = resolveStartupModel(args, loaded.blueprintModelId, cfg);

// Boot manifest: full operational snapshot for debugging, audit, and cost attribution.
traceEvent("boot:manifest", {
	version: BUILD_INFO.version,
	gitHash: BUILD_INFO.gitHash,
	gitBranch: BUILD_INFO.gitBranch,
	channel: BUILD_INFO.channel,
	nodeVersion: process.version,
	pid: process.pid,
	sessionId: session.id,
	cwd: args.cwd,
	model: model.id,
	contextWindow: model.contextWindow,
	reasoning: model.reasoning,
	blueprint: loaded.blueprintName ?? null,
	blueprintPath: loaded.blueprintPath ?? null,
	adapters: loaded.adapters.map((a) => a.name),
	adapterCount: loaded.adapters.length,
	environment: env.mode,
	canWarmReboot: env.canWarmReboot,
	tui: !args.noTui,
});

import("@dpopsuev/alef-ai/models").then((m) => m.refreshModelRegistry()).catch(() => {});

// Build service: register when dev environment has a build command.
// The RebootPort composes build + exit(75) -- the wrapper handles respawn.
// Skip when an external process supervisor owns reboot via ALEF_SUPERVISOR=1 IPC.
if (env.canWarmReboot && process.env.ALEF_SUPERVISOR !== "1") {
	const { setRebootPort } = await import("./boot/reboot-port.js");
	runtime.registerBuildService({
		buildCommand: env.buildCommand!,
		cwd: args.cwd,
		onReady: (buildService) => {
			setRebootPort({ reboot: () => buildService.build() });
		},
		onStopped: () => setRebootPort(undefined),
		onEvent: (event) => {
			traceEvent(`build:${event.phase}`, event);
		},
	});
}

runtime.registerApplicationServices({
	args,
	cfg,
	log,
	store: session,
	loaded,
	model,
	storage,
	identity,
	reloadAdapters: () => {
		const reloadArgs = { ...args, blueprint: loaded.blueprintName ?? loaded.blueprintPath ?? args.blueprint };
		return loadAdapters(reloadArgs, cfg, log, sessionDir, {
			resolveService: runtime.resolveService,
			actorAddress: identity.agentActor.address,
			sessionId: session.id,
			discussion,
		});
	},
});

// Theme
const [isDark, terminalPalette] = await Promise.all([
	isTermDark().then((r: boolean | null | undefined) => r ?? true),
	queryPalette([...TERMINAL_PALETTE_SLOTS]),
]);
loadTheme(
	loaded.blueprintPath ? new URL("..", `file://${loaded.blueprintPath}`).pathname : undefined,
	cfg.theme?.name,
	cfg.theme?.colors,
	isDark,
	terminalPalette,
);

// Start agent + TUI (topo-sorted: storage already running, agent first, TUI after)
await runtime.start();

const sessionRaw = runtime.get("session");
if (sessionRaw && "session" in sessionRaw) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'session' in check; SessionService.session is SessionHandle at runtime
	dispatchCliOp(args, (sessionRaw as SessionService).session as SessionHandle);
}

// Signal handlers — consolidated shutdown with drain
import { shutdownOTel } from "./boot/otel.js";

const daemonCfg = resolveDaemonConfig(cfg);
let draining = false;

/** Drain active work and stop all Foundry services on process signal. */
async function gracefulShutdown(signal: string): Promise<void> {
	if (draining) {
		process.stderr.write(`[alef] second ${signal} — force exit\n`);
		process.exit(1);
	}
	draining = true;
	process.stderr.write(`[alef] ${signal} — draining (${daemonCfg.grace_period}s grace)…\n`);

	const graceTimer = setTimeout(() => {
		process.stderr.write("[alef] grace period expired — force exit\n");
		process.exit(1);
	}, daemonCfg.grace_period * 1000);
	graceTimer.unref();

	await runtime.stop();
	await Promise.race([shutdownOTel(), new Promise<void>((r) => setTimeout(r, 2000).unref())]);
	clearTimeout(graceTimer);
	process.exit(0);
}

process.on("SIGTERM", () => {
	gracefulShutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
	gracefulShutdown("SIGINT").catch(() => process.exit(1));
});

const { awaitProcessLifetime } = await import("./boot/process-lifetime.js");
const tuiRaw = runtime.get("tui");
await awaitProcessLifetime({
	daemon: args.daemon,
	serve: args.serve !== undefined && !args.print,
	done:
		tuiRaw && "done" in tuiRaw
			? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'done' in check
				(tuiRaw as unknown as { done: Promise<void> }).done
			: undefined,
});

await runtime.stop();
process.exit(0);
