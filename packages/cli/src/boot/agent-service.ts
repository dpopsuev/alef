import { randomUUID } from "node:crypto";
import { defineManagedService } from "@dpopsuev/alef-foundry";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Args } from "./args.js";
import { type AlefConfig, resolveDaemonConfig } from "./config.js";
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
			if (opts.args.daemon && surface && listenPort !== undefined) {
				const token = randomUUID();
				surface.router.setAuthToken(token);

				const daemonRegistry = opts.storage.daemonRegistry();
				const addr = surface.router.address();
				await daemonRegistry.register({
					port: listenPort,
					host: addr?.host ?? opts.args.host ?? "127.0.0.1",
					pid: process.pid,
					sessionId: sessionSvc.session.state.id,
					cwd: opts.args.cwd,
					startedAt: Date.now(),
					token,
				});
				process.stderr.write(`[alef] daemon token: ${token}\n`);
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
				stop() {
					stopped = true;
					if (heartbeatTimer) clearInterval(heartbeatTimer);
					surface?.router.setDraining();
					return Promise.resolve();
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	});
}
