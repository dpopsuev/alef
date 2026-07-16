import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createFactoryAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "factory",
	restart: "temporary",
	shareable: false,
	createAdapter(opts) {
		return createFactoryAdapter({ cwd: opts.cwd });
	},
});
