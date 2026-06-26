import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createWebAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "web",
	restart: "transient",
	shareable: true,

	create(_opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createWebAdapter();

		return Promise.resolve({
			name: "web",
			restart: "transient" as const,
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			health: () => Promise.resolve(true),
		});
	},
};
