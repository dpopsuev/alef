import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createFactoryAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "factory",
	restart: "temporary",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createFactoryAdapter({ cwd: opts.cwd });

		return Promise.resolve({
			name: "factory",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
