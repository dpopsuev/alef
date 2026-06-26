import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createSkillsAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "skills",
	restart: "transient",
	shareable: true,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createSkillsAdapter({ cwd: opts.cwd, logger: opts.logger });

		return {
			name: "skills",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			async start() {},

			async stop() {},

			async health() {
				return true;
			},
		};
	},
};
