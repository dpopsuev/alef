import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createNodeshAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "nodesh",
	restart: "temporary",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createNodeshAdapter({ cwd: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "nodesh",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
