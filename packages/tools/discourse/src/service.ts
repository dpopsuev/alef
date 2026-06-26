import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createDiscourseAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "discourse",
	restart: "transient",
	shareable: false,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createDiscourseAdapter({ sessionDir: opts.cwd, logger: opts.logger });

		return {
			name: "discourse",
			restart: "transient",
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
