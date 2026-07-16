import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createWorkflowAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "workflow",
	restart: "temporary",
	shareable: false,
	createAdapter(opts) {
		return createWorkflowAdapter({
			cwd: opts.cwd,
			logger: opts.logger,
			def: { name: "default", stations: [], edges: [], start: "", done: "" },
			// eslint-disable-next-line @typescript-eslint/require-await
			runner: { async run() { return { status: "fulfilled", output: null, questions: [] }; } },
		});
	},
});
