/**
 * Walking Skeleton — end-to-end proof that the Spine event buses work.
 *
 * Real organs: TextMessageOrgan.
 * Mock organs: MockLLMOrgan (canned reply, no API call).
 *
 * If this test passes, the architecture is sound:
 * - Corpus emits on Sense, subscribes to Motor
 * - TextMessageOrgan routes Sense/user_message → Motor/llm_request
 * - MockLLMOrgan routes Motor/llm_request → Motor/tool_call(send_message)
 * - TextMessageOrgan routes Motor/tool_call(send_message) → Motor/user_reply
 * - Corpus receives Motor/user_reply and resolves the promise
 * - All events in a turn carry the same correlationId
 */

import { TextMessageOrgan } from "@dpopsuev/alef-organ-text-message";
import { BusEventRecorder, MockLLMOrgan } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { Corpus } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	corpus: Corpus;
	recorder: BusEventRecorder;
	dispose(): void;
}

function createHarness(cannedText = "walking skeleton reply"): Harness {
	const recorder = new BusEventRecorder();
	const corpus = new Corpus({ timeoutMs: 1000 });
	corpus.load(recorder).load(new TextMessageOrgan()).load(new MockLLMOrgan(cannedText));
	return { corpus, recorder, dispose: () => corpus.dispose() };
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
	it("corpus.prompt() resolves with MockLLMOrgan canned text", async () => {
		const { corpus } = make("pong");
		expect(await corpus.prompt("ping")).toBe("pong");
	});

	it("Sense/user_message carries prompt text and loaded tools", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hello world");

		const msg = recorder.assertSenseEmitted("user_message");
		if (msg.type !== "user_message") throw new Error("wrong type");
		expect(msg.text).toBe("hello world");
		expect(msg.tools.some((t) => t.name === "send_message")).toBe(true);
	});

	it("Motor/llm_request carries user message content", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("what is 2+2?");

		const req = recorder.assertMotorEmitted("llm_request");
		if (req.type !== "llm_request") throw new Error("wrong type");
		const msg = req.messages[0] as { role: string; content: string };
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("what is 2+2?");
	});

	it("Motor/tool_call(send_message) carries canned reply text", async () => {
		const { corpus, recorder } = make("the answer is 4");
		await corpus.prompt("what is 2+2?");

		const call = recorder.assertToolCallEmitted("send_message");
		expect(call.args.text).toBe("the answer is 4");
	});

	it("Motor/user_reply carries the final reply text", async () => {
		const { corpus, recorder } = make("done");
		await corpus.prompt("go");

		const reply = recorder.assertMotorEmitted("user_reply");
		if (reply.type !== "user_reply") throw new Error("wrong type");
		expect(reply.text).toBe("done");
	});

	it("all events in a turn share the same correlationId", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const sense = recorder.assertSenseEmitted("user_message");
		const llmReq = recorder.assertMotorEmitted("llm_request");
		const toolCall = recorder.assertToolCallEmitted("send_message");
		const userReply = recorder.assertMotorEmitted("user_reply");

		const id = sense.correlationId;
		expect(llmReq.correlationId).toBe(id);
		expect(toolCall.correlationId).toBe(id);
		expect(userReply.correlationId).toBe(id);
	});

	it("full event sequence fires on correct buses", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("sequence test");

		const senseTypes = recorder.sense.map((e) => e.type);
		const motorTypes = recorder.motor.map((e) => e.type);

		// Sense: user prompt entered the system
		expect(senseTypes).toContain("user_message");

		// Motor: system acted — LLM requested, tool called, reply sent
		expect(motorTypes).toContain("llm_request");
		expect(motorTypes).toContain("tool_call");
		expect(motorTypes).toContain("user_reply");
	});

	it("concurrent prompts resolve independently with correct text", async () => {
		const { corpus } = make("ok");
		const replies = await Promise.all([corpus.prompt("one"), corpus.prompt("two"), corpus.prompt("three")]);
		expect(replies).toEqual(["ok", "ok", "ok"]);
	});
});
