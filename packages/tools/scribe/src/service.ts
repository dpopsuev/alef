import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createScribeAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "scribe",
	restart: "transient",
	shareable: true,

	async create(_opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createScribeAdapter();

		return {
			name: "scribe",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			async start() {},

			async stop() {
				if ("close" in adapter && typeof adapter.close === "function") {
					await (adapter.close as () => Promise<void>)();
				}
			},

			async health() {
				return true;
			},
		};
	},
};
