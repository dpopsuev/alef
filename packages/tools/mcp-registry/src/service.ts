import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createMcpRegistryAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "mcp-registry",
	restart: "permanent",
	shareable: true,
	createAdapter(opts) {
		return createMcpRegistryAdapter({ cwd: opts.cwd });
	},
});
