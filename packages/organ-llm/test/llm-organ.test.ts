import { Corpus } from "@dpopsuev/alef-corpus";
import { TextMessageOrgan } from "@dpopsuev/alef-organ-text-message";
import { BusEventRecorder } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { LLMOrgan } from "../src/index.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

function makeModel() {
	return {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function makeHarness() {
	const recorder = new BusEventRecorder();
	const corpus = new Corpus({ timeoutMs: 60_000 });
	corpus.load(new TextMessageOrgan()).load(new LLMOrgan({ model: makeModel() }));
	corpus.observe(recorder);
	return { corpus, recorder, dispose: () => corpus.dispose() };
}

const harnesses: ReturnType<typeof makeHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make() {
	const h = makeHarness();
	harnesses.push(h);
	return h;
}

describe.skipIf(SKIP)("LLMOrgan — real API", () => {
	it("resolves corpus.prompt() with a non-empty reply", async () => {
		const { corpus } = make();
		const reply = await corpus.prompt("Respond with exactly: HEALTH_CHECK_OK");
		expect(reply.length).toBeGreaterThan(0);
		expect(reply).toContain("HEALTH_CHECK_OK");
	}, 30_000);

	it("emits the full event sequence on all buses", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("Say hi in one word.");

		recorder.assertMotorEmitted("text.input");
		recorder.assertSenseEmitted("llm.prompt");
		recorder.assertMotorEmitted("text.message");
		recorder.assertSenseEmitted("text.reply");
	}, 30_000);

	it("text.message args contain the reply text", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("What is 2+2? Reply with just the number.");

		const msg = recorder.assertMotorEmitted("text.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(typeof payload.text).toBe("string");
		expect(payload.text.length).toBeGreaterThan(0);
	}, 30_000);

	it("all turn events share the same correlationId", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("Say yes.");

		const input = recorder.assertMotorEmitted("text.input");
		const prompt = recorder.assertSenseEmitted("llm.prompt");
		const msg = recorder.assertMotorEmitted("text.message");
		const reply = recorder.assertSenseEmitted("text.reply");

		expect(prompt.correlationId).toBe(input.correlationId);
		expect(msg.correlationId).toBe(input.correlationId);
		expect(reply.correlationId).toBe(input.correlationId);
	}, 30_000);
});
