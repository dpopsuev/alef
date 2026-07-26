import { randomUUID } from "node:crypto";
import { defineManagedService } from "@dpopsuev/alef-foundry";
import type { ServiceDescriptor } from "@dpopsuev/alef-foundry/lifecycle";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { Args } from "./args.js";
import type { AssembledSession } from "./assemble-session.js";
import { type AlefConfig, resolveDaemonConfig } from "./config.js";
import { removeDaemonCredential, writeDaemonCredential } from "./daemon-credential.js";

/** Options needed to create the agent daemon service. */
export interface AgentServiceOptions {
	args: Args;
	cfg: AlefConfig;
	storage: StorageFactory;
	session: AssembledSession;
}

/**
 * Build a ServiceDescriptor that manages daemon registration, heartbeat, and HTTP surface readiness.
 * This is Foundry's one genuine independent restart boundary for a running CLI process: an HTTP
 * listener plus a registry entry another process can discover and kill. It takes the already-
 * assembled session directly -- session itself is not a service, so there is nothing to depend on.
 */
export function createAgentServiceDescriptor(opts: AgentServiceOptions): ServiceDescriptor {
	return defineManagedService({
		name: "agent",
		restart: "permanent",
		shareable: false,
		async create() {
			const surface = await opts.session.setupSurface();
			const listenPort = surface?.port;
			const daemonRegistry = opts.args.daemon ? opts.storage.daemonRegistry() : undefined;
			const daemonSessionId = opts.session.session.state.id;
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
				const sid = opts.session.session.state.id;
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
