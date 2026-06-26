import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createLocusAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "locus",
	restart: "transient",
	shareable: true,

	async create(_opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createLocusAdapter();

		return {
			name: "locus",
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
