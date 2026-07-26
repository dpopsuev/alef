import { randomUUID } from "node:crypto";
import { defineManagedService } from "@dpopsuev/alef-foundry";
import type { ServiceDescriptor } from "@dpopsuev/alef-foundry/lifecycle";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { Args } from "./args.js";
import { type AlefConfig, resolveDaemonConfig } from "./config.js";
import { removeDaemonCredential, writeDaemonCredential } from "./daemon-credential.js";
import type { SessionService } from "./session-service.js";

/** Options needed to create the agent supervisor service. */
export interface AgentServiceOptions {
	args: Args;
	cfg: AlefConfig;
	storage: StorageFactory;
}

/** Build a ServiceDescriptor that manages daemon registration, heartbeat, and HTTP surface readiness. */
export function createAgentServiceDescriptor(opts: AgentServiceOptions): ServiceDescriptor {
	return defineManagedService({
		name: "agent",
		restart: "permanent",
		shareable: false,
		dependsOn: ["session"],
		async create(createOpts) {
			const raw = createOpts.supervisor?.get("session");
			if (!raw || !("session" in raw)) throw new Error("Session service not found — agent depends on session");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'session' in check
			const sessionSvc = raw as SessionService;

			const surface = await sessionSvc.setupSurface();
			const listenPort = surface?.port;
			const daemonRegistry = opts.args.daemon ? opts.storage.daemonRegistry() : undefined;
			const daemonSessionId = sessionSvc.session.state.id;
			if (daemonRegistry && surface && listenPort !== undefined) {
				const token = randomUUID();
				surface.router.setAuthToken(token);
				writeDaemonCredential(daemonSessionId, token);

				const addr = surface.router.address();
				try {
					await daemonRegistry.register({
						port: listenPort,
						host: addr?.host ?? opts.args.host ?? "127.0.0.1",
						pid: process.pid,
						sessionId: daemonSessionId,
						cwd: opts.args.cwd,
						startedAt: Date.now(),
					});
				} catch (error) {
					removeDaemonCredential(daemonSessionId);
					throw error;
				}
			}

			surface?.router.setReady();

			let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
			if (opts.args.daemon) {
				const daemonCfg = resolveDaemonConfig(opts.cfg);
				const registry = opts.storage.daemonRegistry();
				const sid = sessionSvc.session.state.id;
				heartbeatTimer = setInterval(() => {
					void registry.heartbeat(sid);
				}, daemonCfg.heartbeat * 1000);
				heartbeatTimer.unref();
			}

			let stopped = false;
			return {
				async stop() {
					stopped = true;
					if (heartbeatTimer) clearInterval(heartbeatTimer);
					surface?.router.setDraining();
					if (daemonRegistry) {
						await daemonRegistry.unregister(daemonSessionId);
						removeDaemonCredential(daemonSessionId);
					}
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	});
}
