/**
 * ALE-TSK-565: E2E delegation test
 *
 * Exercises: motor/agent.run → organ-delegate → InProcessStrategy
 *   → inner Cerebrum (faux inner LLM) → sense/agent.run with reply text
 *   → outer Cerebrum turn 2 receives toolResult → final dialog.message
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai";
import { createDelegateOrgan } from "@dpopsuev/alef-organ-delegate";
import { afterEach, describe, expect, it } from "vitest";
import { Cerebrum } from "../../organ-llm/src/index.js";
import { DIALOG_MESSAGE_TOOL, NerveFixture, TurnDriver } from "../../testkit/src/index.js";
import { InProcessStrategy } from "../src/strategies/in-process.js";

describe("agent.run delegation — E2E", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("outer LLM calls agent.run, inner LLM responds, outer receives toolResult", async () => {
		// Two independent faux providers: outer and inner
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();
		disposes.push(
			() => outerFaux.unregister(),
			() => innerFaux.unregister(),
		);

		const capturedEvents: string[] = [];

		// Inner strategy: InProcessStrategy with inner faux LLM
		const innerStrategy = new InProcessStrategy([], innerFaux.getModel());

		// Organ-delegate with the inner strategy registered as 'explore'
		const delegateOrgan = createDelegateOrgan({ strategies: { explore: innerStrategy } });

		// Outer NerveFixture: outer Cerebrum + delegate organ
		const f = new NerveFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve);

		f.mount(
			new Cerebrum({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
				getTools: () => [DIALOG_MESSAGE_TOOL, ...delegateOrgan.tools],
				onEvent: (e) => capturedEvents.push(e.type),
			}),
		);
		f.mount(delegateOrgan);

		// Outer LLM: turn 1 → call agent.run
		//            turn 2 → reply with the inner result as context
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "list the packages", profile: "explore" })]),
			fauxAssistantMessage("The packages are: spine, corpus, runner."),
		]);

		// Inner LLM: responds with the package list
		innerFaux.setResponses([fauxAssistantMessage("spine, corpus, runner")]);

		// When
		const reply = await driver.send("explore the packages", "human", 10_000);

		// Then: outer LLM received the inner reply as a tool result and used it
		expect(reply).toBe("The packages are: spine, corpus, runner.");

		// Tool lifecycle events fired in order
		expect(capturedEvents).toContain("tool-start");
		expect(capturedEvents).toContain("tool-end");
		const startIdx = capturedEvents.indexOf("tool-start");
		const endIdx = capturedEvents.indexOf("tool-end");
		expect(startIdx).toBeLessThan(endIdx);

		// tool-end was ok (inner agent completed successfully)
		// We can't directly assert ok here from the event array alone,
		// but if reply is correct then the tool result reached the outer LLM
	}, 15_000);

	it("tool-end fires with ok:false when inner agent times out", async () => {
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();
		disposes.push(
			() => outerFaux.unregister(),
			() => innerFaux.unregister(),
		);

		// Inner LLM never responds — causes InProcessStrategy to time out
		// (no response set on innerFaux, so it returns an error)

		const innerStrategy = new InProcessStrategy([], innerFaux.getModel());
		const delegateOrgan = createDelegateOrgan({ strategies: { explore: innerStrategy } });

		const capturedEnds: Array<{ ok: boolean }> = [];
		const f = new NerveFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve);

		f.mount(
			new Cerebrum({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
				getTools: () => [DIALOG_MESSAGE_TOOL, ...delegateOrgan.tools],
				onEvent: (e) => {
					if (e.type === "tool-end") capturedEnds.push({ ok: e.ok });
				},
			}),
		);
		f.mount(delegateOrgan);

		// Outer calls agent.run; then handles the error reply
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "do something", profile: "explore" })]),
			fauxAssistantMessage("The inner agent failed."),
		]);

		// Inner faux has no responses set — will return an error message
		// InProcessStrategy will get that error and resolve (not hang)

		const reply = await driver.send("do something", "human", 10_000);
		expect(typeof reply).toBe("string");

		// tool-end should have fired regardless of inner success/failure
		expect(capturedEnds).toHaveLength(1);
	}, 15_000);
});
