import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createWorkflowAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "workflow",
	restart: "temporary",
	shareable: false,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createWorkflowAdapter({
			cwd: opts.cwd,
			logger: opts.logger,
			def: { name: "default", stations: [], edges: [], start: "", done: "" },
			runner: { async run() { return { status: "fulfilled", output: null, questions: [] }; } },
		});

		return {
			name: "workflow",
			restart: "temporary",
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
