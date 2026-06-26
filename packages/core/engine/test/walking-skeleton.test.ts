/**
 * Walking Skeleton — end-to-end proof of the Spine event architecture.
 *
 * Real adapters: TextMessageAdapter (adapter).
 * Mock adapters: MockReasoner (LlmAdapter, canned reply).
 *
 * Event chain:
 *   Agent.publishCommand("llm.input")
 *     → TextMessageAdapter → Event.publish("llm.input")
 *       → MockReasoner  → Command.publish("llm.response")
 *     → TextMessageAdapter → Event.publish("llm.response")
 *   Agent.subscribeEvent("llm.response") → resolves
 */

import { AgentController } from "@dpopsuev/alef-engine/controller";
import { BusEventRecorder, MockReasoner } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";

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

	it("Event/llm.input carries prompt text", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("hello world");

		const msg = recorder.assertEventEmitted("llm.input");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("hello world");
	});

	it("Event/llm.input carries user message content", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("what is 2+2?");

		const req = recorder.assertEventEmitted("llm.input");
		const payload = (req as unknown as { payload: { text: string; sender: string } }).payload;
		expect(payload.text).toBe("what is 2+2?");
		expect(payload.sender).toBe("human");
	});

	it("Command/llm.response carries canned reply text", async () => {
		const { agent: _agent, controller, recorder } = make("the answer is 4");
		await controller.send("what is 2+2?");

		const msg = recorder.assertCommandEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("the answer is 4");
	});

	it("Command/llm.response carries the agent reply", async () => {
		const { agent: _agent, controller, recorder } = make("done");
		await controller.send("go");

		// The LLM reply is Command/"llm.response" — controller.send() awaits it
		const commandEvents = recorder.command.filter((e) => e.type === "llm.response");
		const reply = commandEvents[commandEvents.length - 1];
		const payload = (reply as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("done");
	});

	it("all events in a turn share the same correlationId", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("test");

		const eventInput = recorder.assertEventEmitted("llm.input");
		const commandReply = recorder.assertCommandEmitted("llm.response");

		expect(commandReply.correlationId).toBe(eventInput.correlationId);
	});

	it("full event sequence fires on correct buses", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("sequence test");

		const commandTypes = recorder.command.map((e) => e.type);
		const eventTypes = recorder.event.map((e) => e.type);

		expect(commandTypes).toContain("llm.response");
		expect(eventTypes).toContain("llm.input");
		expect(commandTypes).toContain("llm.response");
		expect(eventTypes).toContain("llm.input");
	});

	it("concurrent prompts resolve independently", async () => {
		const { agent: _agent, controller } = make("ok");
		const replies = await Promise.all([controller.send("one"), controller.send("two"), controller.send("three")]);
		expect(replies).toEqual(["ok", "ok", "ok"]);
	});
});
