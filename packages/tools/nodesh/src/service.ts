import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createNodeshAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "nodesh",
	restart: "temporary",
	shareable: false,
	createAdapter(opts) {
		return createNodeshAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
