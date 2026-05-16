/**
 * Walking Skeleton — end-to-end proof of the Spine event architecture.
 *
 * Real organs: TextMessageOrgan (CorpusOrgan).
 * Mock organs: MockLLMOrgan (CerebrumOrgan, canned reply).
 *
 * Event chain:
 *   Agent.publishMotor("dialog.message")
 *     → TextMessageOrgan → Sense.publish("dialog.message")
 *       → MockLLMOrgan  → Motor.publish("dialog.message")
 *     → TextMessageOrgan → Sense.publish("dialog.message")
 *   Agent.subscribeSense("dialog.message") → resolves
 */

import { BusEventRecorder, MockLLMOrgan } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	agent: Agent;
	dialog: DialogOrgan;
	recorder: BusEventRecorder;
	dispose(): void;
}

function createHarness(cannedText = "walking skeleton reply"): Harness {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
	agent.load(dialog).load(new MockLLMOrgan(cannedText));
	agent.observe(recorder);
	return { agent, dialog, recorder, dispose: () => agent.dispose() };
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make(canned?: string): Harness {
	const h = createHarness(canned);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe("Walking Skeleton", () => {
	it("dialog.send() resolves with MockLLMOrgan canned text", async () => {
		const { agent: _corpus, dialog } = make("pong");
		expect(await dialog.send("ping")).toBe("pong");
	});

	it("Sense/dialog.message (input) carries prompt text and loaded tools", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("hello world");

		const msg = recorder.assertSenseEmitted("dialog.message");
		const payload = (msg as unknown as { payload: { text: string; tools: unknown[] } }).payload;
		expect(payload.text).toBe("hello world");
		expect(Array.isArray(payload.tools)).toBe(true);
	});

	it("Sense/dialog.message carries user message content", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("what is 2+2?");

		const req = recorder.assertSenseEmitted("dialog.message");
		const payload = (req as unknown as { payload: { text: string; sender: string } }).payload;
		expect(payload.text).toBe("what is 2+2?");
		expect(payload.sender).toBe("human");
	});

	it("Motor/dialog.message carries canned reply text", async () => {
		const { agent: _corpus, dialog, recorder } = make("the answer is 4");
		await dialog.send("what is 2+2?");

		const msg = recorder.assertMotorEmitted("dialog.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("the answer is 4");
	});

	it("Motor/dialog.message carries the agent reply", async () => {
		const { agent: _corpus, dialog, recorder } = make("done");
		await dialog.send("go");

		// The LLM reply is Motor/"dialog.message" — dialog.send() awaits it
		const motorEvents = recorder.motor.filter((e) => e.type === "dialog.message");
		const reply = motorEvents[motorEvents.length - 1];
		const payload = (reply as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("done");
	});

	it("all events in a turn share the same correlationId", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("test");

		const senseInput = recorder.assertSenseEmitted("dialog.message");
		const motorReply = recorder.assertMotorEmitted("dialog.message");

		expect(motorReply.correlationId).toBe(senseInput.correlationId);
	});

	it("full event sequence fires on correct buses", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("sequence test");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("dialog.message");
		expect(senseTypes).toContain("dialog.message");
		expect(motorTypes).toContain("dialog.message");
		expect(senseTypes).toContain("dialog.message");
	});

	it("concurrent prompts resolve independently", async () => {
		const { agent: _corpus, dialog } = make("ok");
		const replies = await Promise.all([dialog.send("one"), dialog.send("two"), dialog.send("three")]);
		expect(replies).toEqual(["ok", "ok", "ok"]);
	});
});
