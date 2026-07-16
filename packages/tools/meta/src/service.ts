import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createMetaAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "meta",
	restart: "temporary",
	shareable: false,
	createAdapter(opts) {
		return createMetaAdapter({ cwd: opts.cwd, dialogEventType: "llm.input" });
	},
});
