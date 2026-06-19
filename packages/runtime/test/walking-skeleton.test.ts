/**
 * Walking Skeleton — end-to-end proof of the Spine event architecture.
 *
 * Real organs: TextMessageOrgan (organ).
 * Mock organs: MockReasoner (LlmOrgan, canned reply).
 *
 * Event chain:
 *   Agent.publishMotor("llm.input")
 *     → TextMessageOrgan → Sense.publish("llm.input")
 *       → MockReasoner  → Motor.publish("llm.response")
 *     → TextMessageOrgan → Sense.publish("llm.response")
 *   Agent.subscribeSense("llm.response") → resolves
 */

import { AgentController } from "@dpopsuev/alef-runtime";
import { BusEventRecorder, MockReasoner } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	agent: Agent;
	controller: AgentController;
	recorder: BusEventRecorder;
	dispose(): void;
}

function createHarness(cannedText = "walking skeleton reply"): Harness {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	agent.load(new MockReasoner(cannedText));
	agent.observe(recorder);
	const controller = new AgentController(agent);
	return { agent, controller, recorder, dispose: () => agent.dispose() };
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

describe("Walking Skeleton", { tags: ["integration"] }, () => {
	it("controller.send() resolves with MockReasoner canned text", async () => {
		const { agent: _agent, controller } = make("pong");
		expect(await controller.send("ping")).toBe("pong");
	});

	it("Sense/llm.input carries prompt text", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("hello world");

		const msg = recorder.assertSenseEmitted("llm.input");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("hello world");
	});

	it("Sense/llm.input carries user message content", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("what is 2+2?");

		const req = recorder.assertSenseEmitted("llm.input");
		const payload = (req as unknown as { payload: { text: string; sender: string } }).payload;
		expect(payload.text).toBe("what is 2+2?");
		expect(payload.sender).toBe("human");
	});

	it("Motor/llm.response carries canned reply text", async () => {
		const { agent: _agent, controller, recorder } = make("the answer is 4");
		await controller.send("what is 2+2?");

		const msg = recorder.assertMotorEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("the answer is 4");
	});

	it("Motor/llm.response carries the agent reply", async () => {
		const { agent: _agent, controller, recorder } = make("done");
		await controller.send("go");

		// The LLM reply is Motor/"llm.response" — controller.send() awaits it
		const motorEvents = recorder.motor.filter((e) => e.type === "llm.response");
		const reply = motorEvents[motorEvents.length - 1];
		const payload = (reply as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("done");
	});

	it("all events in a turn share the same correlationId", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("test");

		const senseInput = recorder.assertSenseEmitted("llm.input");
		const motorReply = recorder.assertMotorEmitted("llm.response");

		expect(motorReply.correlationId).toBe(senseInput.correlationId);
	});

	it("full event sequence fires on correct buses", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("sequence test");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
	});

	it("concurrent prompts resolve independently", async () => {
		const { agent: _agent, controller } = make("ok");
		const replies = await Promise.all([controller.send("one"), controller.send("two"), controller.send("three")]);
		expect(replies).toEqual(["ok", "ok", "ok"]);
	});
});
