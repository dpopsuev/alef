import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createFactoryAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "factory",
	restart: "temporary",
	shareable: false,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createFactoryAdapter({ cwd: opts.cwd });

		return {
			name: "factory",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			async start() {},

			async stop() {},

			async health() {
				return true;
			},
		};
	},
};
