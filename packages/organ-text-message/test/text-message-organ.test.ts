import { Corpus } from "@dpopsuev/alef-corpus";
import { BusEventRecorder, MockLLMOrgan } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { TextMessageOrgan } from "../src/index.js";

function makeHarness(cannedText = "mock reply") {
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
// Tool definition
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — tool definition", () => {
	it("exposes text.message as its only tool", () => {
		const organ = new TextMessageOrgan();
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0]?.name).toBe("text.message");
	});

	it("kind is corpus", () => {
		expect(new TextMessageOrgan().kind).toBe("corpus");
	});

	it("text.message tool definition is included in llm.prompt tools", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hi");

		const req = recorder.assertSenseEmitted("llm.prompt");
		const payload = (req as unknown as { payload: { tools: { name: string }[] } }).payload;
		expect(payload.tools.some((t) => t.name === "text.message")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// text.input → llm.prompt
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — text.input → llm.prompt", () => {
	it("emits llm.prompt when text.input arrives", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hello");
		recorder.assertSenseEmitted("llm.prompt");
	});

	it("llm.prompt carries user text as message content", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("what time is it?");

		const req = recorder.assertSenseEmitted("llm.prompt");
		const payload = (req as unknown as { payload: { messages: { role: string; content: string }[] } }).payload;
		expect(payload.messages[0]?.role).toBe("user");
		expect(payload.messages[0]?.content).toBe("what time is it?");
	});

	it("llm.prompt carries the same correlationId as text.input", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const motor = recorder.assertMotorEmitted("text.input");
		const sense = recorder.assertSenseEmitted("llm.prompt");
		expect(sense.correlationId).toBe(motor.correlationId);
	});
});

// ---------------------------------------------------------------------------
// text.message → text.reply
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — text.message → text.reply", () => {
	it("emits text.reply when text.message arrives", async () => {
		const { corpus, recorder } = make("response text");
		await corpus.prompt("hi");
		recorder.assertSenseEmitted("text.reply");
	});

	it("corpus.prompt() resolves with canned text", async () => {
		const { corpus } = make("the answer is 42");
		expect(await corpus.prompt("what is the answer?")).toBe("the answer is 42");
	});

	it("text.reply carries same correlationId as text.message", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const msg = recorder.assertMotorEmitted("text.message");
		const reply = recorder.assertSenseEmitted("text.reply");
		expect(reply.correlationId).toBe(msg.correlationId);
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — full round-trip", () => {
	it("resolves through the full Spine event chain", async () => {
		const { corpus } = make("pong");
		expect(await corpus.prompt("ping")).toBe("pong");
	});

	it("concurrent prompts resolve independently", async () => {
		const { corpus } = make("ok");
		const [a, b, c] = await Promise.all([corpus.prompt("one"), corpus.prompt("two"), corpus.prompt("three")]);
		expect([a, b, c]).toEqual(["ok", "ok", "ok"]);
	});

	it("full event sequence on correct buses", async () => {
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
