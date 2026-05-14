/**
 * Walking Skeleton — end-to-end proof of the Spine event architecture.
 *
 * Real organs: TextMessageOrgan (CorpusOrgan).
 * Mock organs: MockLLMOrgan (CerebrumOrgan, canned reply).
 *
 * Event chain:
 *   Corpus.publishMotor("text.input")
 *     → TextMessageOrgan → Sense.publish("llm.prompt")
 *       → MockLLMOrgan  → Motor.publish("text.message")
 *     → TextMessageOrgan → Sense.publish("text.reply")
 *   Corpus.subscribeSense("text.reply") → resolves
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
	corpus.load(new TextMessageOrgan()).load(new MockLLMOrgan(cannedText));
	corpus.observe(recorder);
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

	it("Motor/text.input carries prompt text and loaded tools", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hello world");

		const msg = recorder.assertMotorEmitted("text.input");
		const payload = (msg as unknown as { payload: { text: string; tools: unknown[] } }).payload;
		expect(payload.text).toBe("hello world");
		expect(Array.isArray(payload.tools)).toBe(true);
	});

	it("Sense/llm.prompt carries user message content", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("what is 2+2?");

		const req = recorder.assertSenseEmitted("llm.prompt");
		const payload = (req as unknown as { payload: { messages: { role: string; content: string }[] } }).payload;
		expect(payload.messages[0]?.role).toBe("user");
		expect(payload.messages[0]?.content).toBe("what is 2+2?");
	});

	it("Motor/text.message carries canned reply text", async () => {
		const { corpus, recorder } = make("the answer is 4");
		await corpus.prompt("what is 2+2?");

		const msg = recorder.assertMotorEmitted("text.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("the answer is 4");
	});

	it("Sense/text.reply carries the final reply", async () => {
		const { corpus, recorder } = make("done");
		await corpus.prompt("go");

		const reply = recorder.assertSenseEmitted("text.reply");
		const payload = (reply as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("done");
	});

	it("all events in a turn share the same correlationId", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const input = recorder.assertMotorEmitted("text.input");
		const prompt = recorder.assertSenseEmitted("llm.prompt");
		const msg = recorder.assertMotorEmitted("text.message");
		const reply = recorder.assertSenseEmitted("text.reply");

		const id = input.correlationId;
		expect(prompt.correlationId).toBe(id);
		expect(msg.correlationId).toBe(id);
		expect(reply.correlationId).toBe(id);
	});

	it("full event sequence fires on correct buses", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("sequence test");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("text.input");
		expect(senseTypes).toContain("llm.prompt");
		expect(motorTypes).toContain("text.message");
		expect(senseTypes).toContain("text.reply");
	});

	it("concurrent prompts resolve independently", async () => {
		const { corpus } = make("ok");
		const replies = await Promise.all([corpus.prompt("one"), corpus.prompt("two"), corpus.prompt("three")]);
		expect(replies).toEqual(["ok", "ok", "ok"]);
	});
});
