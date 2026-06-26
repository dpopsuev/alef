import type { Api, Model } from "@dpopsuev/alef-llm";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import type { AdapterLoadResult } from "./cli/load-adapters.js";
import { buildIdentityContext, createLocalSession, type IdentityContext } from "./cli/local-session.js";
import type { AlefConfig } from "./config.js";
import type { SessionHandle } from "./session-lifecycle/index.js";
import type { SessionStore } from "./session-store.js";

export interface AgentRuntimeOptions {
	storage: StorageFactory;
}

export interface StartedSession {
	session: SessionHandle;
	resolvedModelDisplay: string;
	humanAddress: string;
	agentAddress: string;
	identity: IdentityContext;
}

export class AgentRuntime {
	private readonly storage: StorageFactory;
	private readonly sessions = new Map<string, SessionHandle>();

	constructor(opts: AgentRuntimeOptions) {
		this.storage = opts.storage;
	}

	get sessionStore(): StorageFactory {
		return this.storage;
	}

	async startSession(
		args: Args,
		cfg: AlefConfig,
		log: Logger,
		store: SessionStore,
		loaded: AdapterLoadResult,
		model: Model<Api>,
	): Promise<StartedSession> {
		const identity = buildIdentityContext(store);
		const { session, resolvedModelDisplay, humanAddress, agentAddress, actorRoutes, setupSurface } =
			await createLocalSession(args, cfg, log, store, loaded, model, this.storage, identity);

		const listenPort = await setupSurface();
		this.sessions.set(session.state.id, session);

		if (args.daemon && listenPort !== undefined) {
			const daemonRegistry = this.storage.daemonRegistry();
			await daemonRegistry.register({
				port: listenPort,
				pid: process.pid,
				sessionId: session.state.id,
				cwd: args.cwd,
				startedAt: Date.now(),
			});
		}

		return {
			session,
			resolvedModelDisplay,
			humanAddress,
			agentAddress,
			identity: { ...identity, actorRoutes },
		};
	}

	list(): Array<{ id: string; modelId: string }> {
		return Array.from(this.sessions.entries()).map(([id, s]) => ({
			id,
			modelId: s.state.modelId,
		}));
	}

	get(id: string): SessionHandle | undefined {
		return this.sessions.get(id);
	}

	async stopSession(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (session) {
			session.dispose();
			this.sessions.delete(id);
			await this.storage
				.daemonRegistry()
				.unregister(id)
				.catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		const daemonRegistry = this.storage.daemonRegistry();
		for (const [id, session] of this.sessions) {
			session.dispose();
			await daemonRegistry.unregister(id).catch(() => {});
		}
		this.sessions.clear();
		const storage: object = this.storage;
		if ("close" in storage && typeof storage.close === "function") {
			(storage.close as () => void)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- duck-type check above
		}
	}
}
