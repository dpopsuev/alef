import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createMcpRegistryAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "mcp-registry",
	restart: "permanent",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createMcpRegistryAdapter({ cwd: opts.cwd });

		return Promise.resolve({
			name: "mcp-registry",
			restart: "permanent",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			async stop() {
				await adapter.close?.();
			},

			health: () => Promise.resolve(true),
		});
	},
};
