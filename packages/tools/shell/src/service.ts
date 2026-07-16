import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createShellAdapter } from "./adapter.js";

/** Supervisor service descriptor for the shell adapter. */
export const service = defineAdapterService({
	name: "shell",
	restart: "permanent",
	shareable: true,
	createAdapter(opts) {
		return createShellAdapter({ cwd: opts.cwd, logger: opts.logger });
	},
});
