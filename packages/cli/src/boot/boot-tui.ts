/**
 * TUI boot path -- wires the Bootstrapper into the existing entrypoint
 * for the headful (TUI) case.
 *
 * This replaces the inline sequential boot in entrypoint.ts Phase 3
 * when willUseTui is true. Non-TUI paths (print, json, serve) remain
 * unchanged in the entrypoint.
 */

import { dirname } from "node:path";
import { resolveStartupModel } from "@dpopsuev/alef-agent/model";
import { initSessionSink, traceEvent } from "@dpopsuev/alef-kernel/log";
import type { AdapterManagementSession } from "@dpopsuev/alef-session/contracts";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { detectEnvironment } from "@dpopsuev/alef-supervisor/environment";
import { isTermDark } from "is-term-dark";
import type { Logger } from "pino";
import { pickBlueprintInTui } from "../client/blueprint-picker-app.js";
import type { ResolvedSession, SessionSelection, TuiShell, WireSessionDeps } from "../client/boot-types.js";
import { pickSessionInTui } from "../client/session-picker-app.js";
import { loadTheme, queryPalette, TERMINAL_PALETTE_SLOTS } from "../client/theme.js";
import { bootTuiShell, wireSession } from "../client/tui-shell.js";
import { loadAdapters } from "./adapters.js";
import type { Args } from "./args.js";
import { discoverBlueprints } from "./blueprints.js";
import { createBootstrapper } from "./bootstrapper.js";
import { BUILD_INFO } from "./build-info.js";
import { type AlefConfig, getConfig } from "./config.js";
import { deriveDiscussionRef } from "./discussion.js";
import type { CliFoundryRuntime } from "./foundry-runtime.js";
import { getRebootPort, getRestartStrategy, setRebootPort } from "./reboot-port.js";
import { buildIdentityContext, getUiSignalHandlers, isCompacted } from "./session.js";
import type { SessionService } from "./session-service.js";

/** Dependencies for the TUI boot path. */
export interface TuiBootDeps {
	args: Args;
	cfg: AlefConfig;
	log: Logger;
	runtime: CliFoundryRuntime;
	storage: StorageFactory;
}

/**
 * Run the TUI boot path via the Bootstrapper.
 *
 * Replaces the sequential inline boot in entrypoint.ts Phase 3.
 * Returns when the TUI stops (user quit).
 */
export async function bootWithBootstrapper(deps: TuiBootDeps): Promise<void> {
	const { args, cfg, log, runtime, storage } = deps;
	const env = detectEnvironment(args.cwd);

	let shellRef: TuiShell | null = null;
	let resolvedRef: ResolvedSession | null = null;
	let sessionHandleRef: Partial<AdapterManagementSession> | null = null;

	const restartSupervisor = async (): Promise<void> => {
		await runtime.stop();
		await runtime.start();
	};

	const restartTui = (): Promise<void> => {
		if (!shellRef || !resolvedRef) return Promise.resolve();
		shellRef.tui.stop();
		const newShell = bootTuiShell({ cwd: args.cwd, buildInfo: BUILD_INFO });
		shellRef = newShell;
		wireSession(newShell, resolvedRef, buildWireSessionDeps());
		return Promise.resolve();
	};

	/**
	 * Build the full WireSessionDeps object -- the single source of truth for
	 * both the initial cold-boot wire (getDeps) and every warm restart
	 * (restartTui), so a restart can never hand the TUI an incomplete deps set.
	 */
	const buildWireSessionDeps = (): WireSessionDeps => ({
		signalHandlers: getUiSignalHandlers(),
		isCompacted,
		rebootPort: getRebootPort(),
		restartStrategy: getRestartStrategy(),
		checkForUpdate: () => import("./version-check.js").then((m) => m.checkForUpdate()),
		restartTui,
		restartSupervisor,
		buildInfo: BUILD_INFO,
		getConfig,
		reloadAdapters: async (_names: string[]) => {
			if (!sessionHandleRef) return;
			for (const name of _names) {
				sessionHandleRef.unloadAdapter?.(name);
			}
			// Full adapter reload via the runtime's registered reload callback
			const { foundry } = runtime;
			const sessionSvc = foundry.get("session");
			if (sessionSvc && "reboot" in sessionSvc) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'reboot' in check
				await (sessionSvc as unknown as { reboot(): Promise<void> }).reboot();
			}
		},
	});

	const handle = createBootstrapper({
		cwd: args.cwd,
		willUseTui: true,
		buildInfo: BUILD_INFO,

		createShell(ctx) {
			const s = bootTuiShell(ctx);
			shellRef = s;
			return s;
		},

		async pickSession(shell) {
			const _preview = storage.sessionPreview();
			const sessions = storage.sessions;

			// Check if there are existing sessions to pick from
			const existing = await sessions.list(args.cwd);
			const all = existing.length === 0 ? await sessions.listAll() : [];

			if (existing.length === 0 && all.length === 0) {
				// No sessions -- create a new one directly
				const store = await sessions.create(args.cwd);
				return { store, isNew: true };
			}

			// Run the picker inside the TUI
			const pickedId = shell ? await pickSessionInTui(shell, { cwd: args.cwd, sessions }) : undefined;

			if (!pickedId) {
				const store = await sessions.create(args.cwd);
				return { store, isNew: true };
			}

			// Resume the picked session
			const local = existing.find((s) => s.id === pickedId);
			const store = local ? await sessions.resume(args.cwd, pickedId) : await sessions.resume(args.cwd, pickedId);
			return { store, isNew: false };
		},

		async resolveSession(selection: SessionSelection) {
			const { store } = selection;

			process.env.ALEF_SESSION_ID = store.id;
			const identity = buildIdentityContext(store);
			const discussion = deriveDiscussionRef(store, args.cwd);

			// Wire trace sink to session store
			initSessionSink((record) => {
				void store.append({
					bus: "internal",
					type: typeof record.type === "string" ? record.type : "debug",
					correlationId: "debug",
					payload: record,
					timestamp: Date.now(),
				});
			});

			traceEvent("boot", {
				pid: process.pid,
				cwd: args.cwd,
				model: args.modelId,
				tui: true,
				sessionId: store.id,
			});

			// Fire-and-forget: embedder init
			void Promise.all([import("@dpopsuev/alef-embedding"), import("@dpopsuev/alef-storage/sqlite/session")])
				.then(([{ setEmbedder, LocalEmbedder, queueEmbedding }, { setEmbeddingCallback }]) => {
					setEmbedder(new LocalEmbedder());
					setEmbeddingCallback(queueEmbedding);
				})
				.catch((err: unknown) => {
					log.warn({ error: String(err) }, "embedder init failed");
				});

			// Blueprint selection (if multiple available and not already specified)
			const resolvedArgs = { ...args };
			if (!resolvedArgs.blueprint) {
				const discovered = discoverBlueprints();
				if (discovered.length > 1 && shellRef) {
					const chosen = await pickBlueprintInTui(shellRef, discovered);
					if (chosen) resolvedArgs.blueprint = chosen.name;
				}
			}

			// Load adapters + model
			const sessionDir = dirname(store.path);
			const loaded = await loadAdapters(resolvedArgs, cfg, log, sessionDir, {
				resolveService: runtime.resolveService,
				actorAddress: identity.agentActor.address,
				sessionId: store.id,
				discussion,
			});
			const model = resolveStartupModel(args, loaded.blueprintModelId, cfg);

			// Boot manifest
			traceEvent("boot:manifest", {
				version: BUILD_INFO.version,
				gitHash: BUILD_INFO.gitHash,
				gitBranch: BUILD_INFO.gitBranch,
				channel: BUILD_INFO.channel,
				nodeVersion: process.version,
				pid: process.pid,
				sessionId: store.id,
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
				tui: true,
			});

			// Model registry refresh (fire-and-forget)
			void import("@dpopsuev/alef-ai/models").then((m) => m.refreshModelRegistry()).catch(() => {});

			// Build service for warm reboot
			if (env.canWarmReboot && process.env.ALEF_SUPERVISOR !== "1") {
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

			// Register application services. registerTui: false -- this Bootstrapper
			// already owns TUI presentation directly (createShell/wireSession below),
			// so the Foundry-managed "tui" service (views.ts's TuiViewMode) would
			// only be redundant here.
			runtime.registerApplicationServices({
				args,
				cfg,
				log,
				store,
				loaded,
				model,
				storage,
				identity,
				registerTui: false,
				reloadAdapters: () => {
					const reloadArgs = {
						...args,
						blueprint: loaded.blueprintName ?? loaded.blueprintPath ?? args.blueprint,
					};
					return loadAdapters(reloadArgs, cfg, log, sessionDir, {
						resolveService: runtime.resolveService,
						actorAddress: identity.agentActor.address,
						sessionId: store.id,
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

			// Start Foundry services -- this is what actually assembles the session
			// (agent, adapters, LLM), via the "session" service registered above.
			// Pull the result from Foundry rather than assembling it again directly,
			// so createLocalSession() runs exactly once per boot.
			await runtime.start();

			const sessionSvc = runtime.get("session");
			if (!sessionSvc || !("session" in sessionSvc)) {
				throw new Error("Session service failed to start");
			}
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'session' in check
			const result = sessionSvc as unknown as SessionService;

			sessionHandleRef = result.session;

			return {
				session: result.session,
				store,
				sessionId: store.id,
				modelId: result.resolvedModelDisplay,
				contextWindow: model.contextWindow,
				isNew: selection.isNew,
				getModel: () => result.session.getModel(),
				setModel: (id: string) => result.session.setModel(id),
				getThinking: () => result.session.getThinking(),
				setThinking: (level: string) => result.session.setThinking(level),
				humanAddress: result.humanAddress,
				agentAddress: result.agentAddress,
				blueprintName: result.blueprintName,
			};
		},

		wireSession: (shell, resolved, wireDeps) => {
			resolvedRef = resolved;
			wireSession(shell, resolved, wireDeps);
		},

		getDeps: () => buildWireSessionDeps(),
	});

	await handle.done;
}
