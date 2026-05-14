import { Corpus } from "@dpopsuev/alef-corpus";
import { TextMessageOrgan } from "@dpopsuev/alef-organ-text-message";
import { afterEach, describe, expect, it } from "vitest";
import { BusEventRecorder, MockLLMOrgan } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(cannedText = "mock response") {
	const recorder = new BusEventRecorder();
	const corpus = new Corpus({ timeoutMs: 1000 });
	corpus.load(new TextMessageOrgan()).load(new MockLLMOrgan(cannedText));
	corpus.observe(recorder);
	return { corpus, recorder, dispose: () => corpus.dispose() };
}

const harnesses: ReturnType<typeof makeHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make(canned?: string) {
	const h = makeHarness(canned);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// MockLLMOrgan
// ---------------------------------------------------------------------------

describe("MockLLMOrgan", () => {
	it("corpus.prompt() resolves with canned text", async () => {
		const { corpus } = make("hello from mock");
		const reply = await corpus.prompt("hi");
		expect(reply).toBe("hello from mock");
	});

	it("canned text is configurable", async () => {
		const { corpus } = make("custom reply");
		expect(await corpus.prompt("anything")).toBe("custom reply");
	});

	it("emits Motor/text.message with canned text", async () => {
		const { corpus, recorder } = make("response text");
		await corpus.prompt("hi");
		const msg = recorder.assertMotorEmitted("text.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("response text");
	});
});

// ---------------------------------------------------------------------------
// BusEventRecorder
// ---------------------------------------------------------------------------

describe("BusEventRecorder", () => {
	it("records Motor/text.input", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertMotorEmitted("text.input");
	});

	it("records Sense/llm.prompt", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertSenseEmitted("llm.prompt");
	});

	it("records Motor/text.message", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertMotorEmitted("text.message");
	});

	it("records Sense/text.reply", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertSenseEmitted("text.reply");
	});

	it("assertSenseEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertSenseEmitted("llm.prompt")).toThrow("Expected Sense/llm.prompt");
	});

	it("assertMotorEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertMotorEmitted("text.message")).toThrow("Expected Motor/text.message");
	});

	it("clear() resets all recorded events", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("first");
		recorder.clear();
		expect(recorder.sense).toHaveLength(0);
		expect(recorder.motor).toHaveLength(0);
	});

	it("assertCorrelationPaired passes when both buses carry the id", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		const msg = recorder.assertMotorEmitted("text.input");
		expect(() => recorder.assertCorrelationPaired(msg.correlationId)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("Harness round-trip", () => {
	it("resolves with canned text", async () => {
		const { corpus } = make("pong");
		expect(await corpus.prompt("ping")).toBe("pong");
	});

	it("full event sequence: text.input → llm.prompt → text.message → text.reply", async () => {
		const { corpus, recorder } = make("done");
		await corpus.prompt("start");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("text.input");
		expect(senseTypes).toContain("llm.prompt");
		expect(motorTypes).toContain("text.message");
		expect(senseTypes).toContain("text.reply");
	});
});
