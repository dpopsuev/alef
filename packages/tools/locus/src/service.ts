import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createLocusAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "locus",
	restart: "transient",
	shareable: true,
	createAdapter() {
		return createLocusAdapter();
	},
});
