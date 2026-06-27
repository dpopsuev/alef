import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createWorkflowAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "workflow",
	restart: "temporary",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createWorkflowAdapter({
			cwd: opts.cwd,
			logger: opts.logger,
			def: { name: "default", stations: [], edges: [], start: "", done: "" },
			runner: { async run() { return { status: "fulfilled", output: null, questions: [] }; } },
		});

		return Promise.resolve({
			name: "workflow",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
