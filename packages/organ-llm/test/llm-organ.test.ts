import { Agent } from "@dpopsuev/alef-corpus";
import { BusEventRecorder } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
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
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
	agent.load(dialog).load(new LLMOrgan({ model: makeModel() }));
	agent.observe(recorder);
	return { agent, dialog, recorder, dispose: () => agent.dispose() };
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
	it("resolves dialog.send() with a non-empty reply", async () => {
		const { agent: _corpus, dialog } = make();
		const reply = await dialog.send("Respond with exactly: HEALTH_CHECK_OK");
		expect(reply.length).toBeGreaterThan(0);
		expect(reply).toContain("HEALTH_CHECK_OK");
	}, 30_000);

	it("emits the full event sequence on all buses", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("Say hi in one word.");

		recorder.assertMotorEmitted("dialog.message");
		recorder.assertSenseEmitted("dialog.message");
		recorder.assertMotorEmitted("dialog.message");
		recorder.assertSenseEmitted("dialog.message");
	}, 30_000);

	it("dialog.message args contain the reply text", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("What is 2+2? Reply with just the number.");

		const msg = recorder.assertMotorEmitted("dialog.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(typeof payload.text).toBe("string");
		expect(payload.text.length).toBeGreaterThan(0);
	}, 30_000);

	it("all turn events share the same correlationId", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("Say yes.");

		const input = recorder.assertMotorEmitted("dialog.message");
		const prompt = recorder.assertSenseEmitted("dialog.message");
		const msg = recorder.assertMotorEmitted("dialog.message");
		const reply = recorder.assertSenseEmitted("dialog.message");

		expect(prompt.correlationId).toBe(input.correlationId);
		expect(msg.correlationId).toBe(input.correlationId);
		expect(reply.correlationId).toBe(input.correlationId);
	}, 30_000);
});
