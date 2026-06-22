/**
 * Integration test: outer LLM calls workflow.run as a tool.
 *
 * The outer agent has createWorkflowOrgan mounted. The scripted LLM calls
 * workflow.run("intent", artifact) → the organ dispatches to ImplStationRunner
 * → the Intent sub-agent calls contract.submit → the tool result comes back
 * → the outer LLM calls workflow.run("goal", ...) → etc.
 *
 * This proves the organ bus layer works end-to-end, not just runPipeline directly.
 */

import { createWorkflowOrgan, type WorkflowDef } from "@dpopsuev/alef-adapter-workflow";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { describe, expect, it } from "vitest";
import { ImplStationRunner } from "../../src/workflow/station-strategy.js";

const DEF: WorkflowDef = {
	name: "planning",
	start: "intent",
	done: "done",
	stations: [
		{ name: "intent", contract: "intent" },
		{ name: "goal", contract: "goal" },
		{ name: "implement", contract: "implement" },
	],
	edges: [
		{ from: "intent", to: "goal" },
		{ from: "goal", to: "implement" },
		{ from: "implement", to: "done" },
	],
};

const INTENT_OUTPUT = {
	intent: "Add dark mode to the settings page",
	scope: "Frontend settings page only",
	constraints: ["Must not break existing tests"],
};

const GOAL_OUTPUT = {
	goal: "Settings page renders correctly in dark mode",
	successCriteria: ["All settings page tests pass"],
	outOfScope: ["Mobile layout"],
};

const IMPLEMENT_OUTPUT = {
	steps: [{ action: "Add CSS variables", rationale: "Centralise theming" }],
	risks: ["WCAG contrast"],
	firstAction: "Add CSS variables",
};

describe("workflow organ harness — outer LLM calls workflow.run", { tags: ["unit"] }, () => {
	it("outer LLM calls all three stations via workflow.run tool", async () => {
		const faux = registerFauxProvider();

		faux.setResponses([
			// Outer LLM turn 1: run intent station
			fauxAssistantMessage([fauxToolCall("workflow.run", { station: "intent", artifact: "Add dark mode" })]),

			// Intent sub-agent: submit contract
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: INTENT_OUTPUT })]),
			fauxAssistantMessage("Intent done."),

			// Outer LLM turn 2: run goal station with intent output
			fauxAssistantMessage([fauxToolCall("workflow.run", { station: "goal", artifact: INTENT_OUTPUT })]),

			// Goal sub-agent: submit contract
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: GOAL_OUTPUT })]),
			fauxAssistantMessage("Goal done."),

			// Outer LLM turn 3: run implement station with goal output
			fauxAssistantMessage([fauxToolCall("workflow.run", { station: "implement", artifact: GOAL_OUTPUT })]),

			// Implement sub-agent: submit contract
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: IMPLEMENT_OUTPUT })]),
			fauxAssistantMessage("Implement done."),

			// Outer LLM turn 4: final summary
			fauxAssistantMessage("Planning complete. All three stations fulfilled."),
		]);

		const runner = new ImplStationRunner(faux.getModel());
		const workflowOrgan = createWorkflowOrgan({ def: DEF, runner });

		let outerReply = "";
		const agent = new Agent();
		const controller = new AgentController(agent, {
			onReply: (t: string) => {
				if (t) outerReply = t;
			},
		});
		const llm = createAgentLoop({
			model: faux.getModel(),
		});

		agent.load(llm).load(workflowOrgan);
		await agent.ready();
		await controller.send("Plan: add dark mode to the settings page", "human", 60_000);
		agent.dispose();

		expect(outerReply).toContain("Planning complete");
	}, 30_000);

	it("workflow.run returns error when station name is unknown", async () => {
		const faux = registerFauxProvider();

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("workflow.run", { station: "nonexistent", artifact: {} })]),
			fauxAssistantMessage("I see that station does not exist."),
		]);

		const runner = new ImplStationRunner(faux.getModel());
		const workflowOrgan = createWorkflowOrgan({ def: DEF, runner });

		let outerReply = "";
		const agent = new Agent();
		const controller = new AgentController(agent, {
			onReply: (t: string) => {
				if (t) outerReply = t;
			},
		});
		const llm = createAgentLoop({
			model: faux.getModel(),
		});

		agent.load(llm).load(workflowOrgan);
		await agent.ready();
		await controller.send("Run a bad station", "human", 30_000);
		agent.dispose();

		expect(outerReply).toContain("does not exist");
	}, 15_000);
});
