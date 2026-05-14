import { Corpus } from "@dpopsuev/alef-corpus";
import { TextMessageOrgan } from "@dpopsuev/alef-organ-text-message";
import { BusEventRecorder } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { LLMOrgan } from "../src/index.js";

// ---------------------------------------------------------------------------
// These tests make real LLM API calls.
// Requires ANTHROPIC_API_KEY in the environment.
// ---------------------------------------------------------------------------

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
	corpus
		.load(recorder)
		.load(new TextMessageOrgan())
		.load(new LLMOrgan({ model: makeModel() }));
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

// ---------------------------------------------------------------------------

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

		recorder.assertSenseEmitted("user_message");
		recorder.assertMotorEmitted("llm_request");
		recorder.assertToolCallEmitted("send_message");
		recorder.assertMotorEmitted("user_reply");
	}, 30_000);

	it("send_message tool_call args contain the reply text", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("What is 2+2? Reply with just the number.");

		const call = recorder.assertToolCallEmitted("send_message");
		expect(typeof call.args.text).toBe("string");
		expect((call.args.text as string).length).toBeGreaterThan(0);
	}, 30_000);

	it("all turn events share the same correlationId", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("Say yes.");

		const msg = recorder.assertSenseEmitted("user_message");
		const req = recorder.assertMotorEmitted("llm_request");
		const call = recorder.assertToolCallEmitted("send_message");
		const reply = recorder.assertMotorEmitted("user_reply");

		expect(req.correlationId).toBe(msg.correlationId);
		expect(call.correlationId).toBe(msg.correlationId);
		expect(reply.correlationId).toBe(msg.correlationId);
	}, 30_000);
});
