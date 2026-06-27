import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createPlanAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "plan",
	restart: "transient",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createPlanAdapter({ sessionDir: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "plan",
			restart: "transient",
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
