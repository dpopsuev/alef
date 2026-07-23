import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createAgentAdapter } from "./adapter.js";

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
		return createAgentAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
