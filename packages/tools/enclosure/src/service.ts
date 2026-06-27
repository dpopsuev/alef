import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createEnclosureAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "enclosure",
	restart: "transient",
	shareable: false,

	create(_opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createEnclosureAdapter();

		return Promise.resolve({
			name: "enclosure",
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
