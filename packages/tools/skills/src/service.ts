import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createSkillsAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "skills",
	restart: "transient",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createSkillsAdapter({ cwd: opts.cwd, logger: opts.logger });

		return Promise.resolve({
			name: "skills",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
