import { ImplStationRunner, runPipeline } from "@dpopsuev/alef-agent/workflow";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { WorkflowDef } from "@dpopsuev/alef-tool-workflow";
import { describe, expect, it } from "vitest";

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
	successCriteria: ["All settings page tests pass", "Dark mode toggle persists across sessions"],
	outOfScope: ["Other pages", "Mobile layout"],
};

const IMPLEMENT_OUTPUT = {
	steps: [
		{ action: "Add CSS variable for dark mode colours", rationale: "Centralise theming" },
		{ action: "Wire toggle to localStorage", rationale: "Persist preference" },
	],
	risks: ["Colour contrast may fail WCAG AA"],
	firstAction: "Add CSS variable for dark mode colours",
};

describe("Intent → Goal → Implement pipeline", { tags: ["unit"] }, () => {
	it("fulfills all three contracts via scripted tool calls", async () => {
		const faux = registerFauxProvider();

		faux.setResponses([
			// Intent station: ask a question then submit
			fauxAssistantMessage([fauxToolCall("question.ask", { question: "Do you want this on mobile too?" })]),
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: INTENT_OUTPUT })]),
			fauxAssistantMessage("Intent station complete."),

			// Goal station: submit directly
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: GOAL_OUTPUT })]),
			fauxAssistantMessage("Goal station complete."),

			// Implement station: submit directly
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: IMPLEMENT_OUTPUT })]),
			fauxAssistantMessage("Implement station complete."),
		]);

		const answers: string[] = [];
		const runner = new ImplStationRunner(faux.getModel(), [], async (q) => {
			answers.push(q);
			return "No, desktop only";
		});

		const result = await runPipeline(DEF, runner, "Add dark mode to settings");

		expect(result.stations.intent?.status).toBe("fulfilled");
		expect(result.stations.intent?.output).toMatchObject({ intent: INTENT_OUTPUT.intent });
		expect(result.stations.intent?.questions).toHaveLength(1);
		expect(answers).toHaveLength(1);
		expect(answers[0]).toBe("Do you want this on mobile too?");

		expect(result.stations.goal?.status).toBe("fulfilled");
		expect((result.stations.goal?.output as typeof GOAL_OUTPUT)?.successCriteria.length).toBeGreaterThanOrEqual(1);

		expect(result.stations.implement?.status).toBe("fulfilled");
		expect((result.stations.implement?.output as typeof IMPLEMENT_OUTPUT)?.firstAction).toBeTruthy();
	}, 15_000);

	it("returns budget_exhausted when contract is never submitted", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("I am done thinking.")]);

		const runner = new ImplStationRunner(faux.getModel());
		const result = await runner.run(DEF.stations[0], "anything");

		expect(result.status).toBe("budget_exhausted");
		expect(result.output).toBeUndefined();
	}, 15_000);

	it("returns validation errors and retries when schema is wrong", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			// First submit is missing required fields
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: { intent: "incomplete" } })]),
			// Agent sees error, submits correctly
			fauxAssistantMessage([fauxToolCall("contract.submit", { data: INTENT_OUTPUT })]),
			fauxAssistantMessage("Done."),
		]);

		const runner = new ImplStationRunner(faux.getModel());
		const result = await runner.run(DEF.stations[0], "a request");

		expect(result.status).toBe("fulfilled");
		expect(result.output).toMatchObject({ intent: INTENT_OUTPUT.intent });
	}, 15_000);
});
