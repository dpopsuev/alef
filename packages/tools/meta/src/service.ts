import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createMetaAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "meta",
	restart: "temporary",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createMetaAdapter({ cwd: opts.cwd, dialogEventType: "llm.input" });

		return Promise.resolve({
			name: "meta",
			restart: "temporary" as const,
			adapters: [adapter],
			tools: [...adapter.tools],
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			health: () => Promise.resolve(true),
		});
	},
};
