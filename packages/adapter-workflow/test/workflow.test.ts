import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createWorkflowOrgan } from "../src/adapter.js";
import type { WorkflowDef } from "../src/schema.js";

const def: WorkflowDef = {
	name: "test",
	start: "a",
	done: "a",
	stations: [{ name: "a", contract: "intent" }],
	edges: [],
};

adapterComplianceSuite(() =>
	createWorkflowOrgan({
		def,
		runner: {
			run: async () => ({ status: "fulfilled", output: {}, questions: [] }),
		},
	}),
);
