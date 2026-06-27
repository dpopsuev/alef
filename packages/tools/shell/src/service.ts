import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createShellAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "shell",
	restart: "permanent",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createShellAdapter({ cwd: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "shell",
			restart: "permanent" as const,
			adapters: [adapter],
			tools: [...adapter.tools],
			start: () => Promise.resolve(),
			stop: () => adapter.close?.() ?? Promise.resolve(),
			health: () => Promise.resolve(true),
		});
	},
};
