import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createFsAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "fs",
	restart: "permanent",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createFsAdapter({ cwd: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "fs",
			restart: "permanent" as const,
			adapters: [adapter],
			tools: [...adapter.tools],
			start: () => Promise.resolve(),
			stop: () => adapter.close?.() ?? Promise.resolve(),
			health: () => Promise.resolve(true),
		});
	},
};
