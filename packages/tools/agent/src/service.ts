import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createAgentAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "agent",
	restart: "transient",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createAgentAdapter({ cwd: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "agent",
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
