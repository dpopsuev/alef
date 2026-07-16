import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createEnclosureAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "enclosure",
	restart: "transient",
	shareable: false,
	createAdapter() {
		return createEnclosureAdapter();
	},
});
