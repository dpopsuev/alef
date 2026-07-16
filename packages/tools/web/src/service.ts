import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createWebAdapter } from "./adapter.js";

/** Supervisor service descriptor for the web adapter. */
export const service = defineAdapterService({
	name: "web",
	restart: "transient",
	shareable: true,
	createAdapter() {
		return createWebAdapter();
	},
});
