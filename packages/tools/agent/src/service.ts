import { defineAdapterService, type FoundryServiceHost, type FoundryStartOptions } from "@dpopsuev/alef-foundry";
import type { ServiceCreateOpts, ServiceRegistry } from "@dpopsuev/alef-foundry/lifecycle";
import { createAgentAdapter } from "./adapter.js";

/**
 * Adapt the platform Supervisor (injected into every ServiceDescriptor.create()
 * call as opts.supervisor) into the narrower FoundryServiceHost shape
 * child-lifecycle.ts expects — so spawned children register into the same
 * Supervisor as every other platform service instead of a private one.
 */
function toServiceHost(supervisor: ServiceRegistry, defaults: Pick<ServiceCreateOpts, "cwd" | "logger">): FoundryServiceHost {
	return {
		get: (name) => supervisor.get(name),
		names: () => supervisor.names(),
		stopService: (name) => supervisor.stop(name),
		ensure: (descriptor, opts?: FoundryStartOptions) =>
			supervisor.getOrStart(descriptor, {
				cwd: opts?.cwd ?? defaults.cwd,
				logger: opts?.logger ?? defaults.logger,
				actorAddress: opts?.actorAddress,
				discussion: opts?.discussion,
				sessionId: opts?.sessionId,
			}),
	};
}

// Named "agent-delegation", not "agent": the CLI's own permanent "agent"
// Foundry service (cli/boot/agent-service.ts) owns daemon registration and
// heartbeat for this running Alef instance. Supervisor's service registry is
// a single flat namespace keyed by name — sharing "agent" between the two
// silently starved the CLI's service (Supervisor.startAll() skips a name
// that's already running, and this adapter-service resolves during
// loadAdapters(), before the CLI registers its own "agent" descriptor).
export const service = defineAdapterService({
	name: "agent-delegation",
	restart: "transient",
	shareable: false,
	createAdapter(opts) {
		const serviceHost = opts.supervisor ? toServiceHost(opts.supervisor, { cwd: opts.cwd, logger: opts.logger }) : undefined;
		return createAgentAdapter({ cwd: opts.cwd, logger: opts.logger, serviceHost });
	},
});
