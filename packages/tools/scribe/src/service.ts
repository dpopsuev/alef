import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createScribeAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "scribe",
	restart: "transient",
	shareable: true,

	create(_opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createScribeAdapter();

		return Promise.resolve({
			name: "scribe",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			async stop() {
				if ("close" in adapter && typeof adapter.close === "function") {
					await (adapter.close as () => Promise<void>)();
				}
			},

			health: () => Promise.resolve(true),
		});
	},
};
