import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createFsAdapter } from "./adapter.js";

/** Supervisor service descriptor for the filesystem adapter. */
export const service = defineAdapterService({
	name: "fs",
	restart: "permanent",
	shareable: true,
	createAdapter(opts) {
		return createFsAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
