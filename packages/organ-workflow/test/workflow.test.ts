import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createWorkflowOrgan } from "../src/organ.js";
import type { WorkflowDef } from "../src/schema.js";

const def: WorkflowDef = {
	name: "test",
	start: "a",
	done: "a",
	stations: [{ name: "a", contract: "intent" }],
	edges: [],
};

organComplianceSuite(() =>
	createWorkflowOrgan({
		def,
		runner: {
			run: async () => ({ status: "fulfilled", output: {}, questions: [] }),
		},
	}),
);
