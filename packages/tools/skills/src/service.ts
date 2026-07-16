import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createSkillsAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "skills",
	restart: "transient",
	shareable: true,
	createAdapter(opts) {
		return createSkillsAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
