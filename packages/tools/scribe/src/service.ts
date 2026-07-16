import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createScribeAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "scribe",
	restart: "transient",
	shareable: true,
	createAdapter() {
		return createScribeAdapter();
	},
});
