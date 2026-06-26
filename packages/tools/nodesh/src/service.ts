import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createNodeshAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "nodesh",
	restart: "temporary",
	shareable: false,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createNodeshAdapter({ cwd: opts.cwd, logger: opts.logger });

		return {
			name: "nodesh",
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
