import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createAgentAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "agent",
	restart: "transient",
	shareable: false,
	createAdapter(opts) {
		return createAgentAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
