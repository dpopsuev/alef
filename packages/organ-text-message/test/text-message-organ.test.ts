import { Corpus } from "@dpopsuev/alef-corpus";
import { BusEventRecorder, MockLLMOrgan } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { TextMessageOrgan } from "../src/index.js";

function makeHarness(cannedText = "mock reply") {
	const recorder = new BusEventRecorder();
	const corpus = new Corpus({ timeoutMs: 1000 });
	corpus.load(recorder).load(new TextMessageOrgan()).load(new MockLLMOrgan(cannedText));
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
	it("exposes send_message as its only tool", () => {
		const organ = new TextMessageOrgan();
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0]?.name).toBe("send_message");
	});

	it("send_message tool has required text property", () => {
		const organ = new TextMessageOrgan();
		const schema = organ.tools[0]?.inputSchema as { required?: string[] };
		expect(schema.required).toContain("text");
	});

	it("send_message tool definition is included in llm_request tools", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hi");

		const req = recorder.assertMotorEmitted("llm_request");
		if (req.type !== "llm_request") throw new Error("wrong type");
		expect(req.tools.some((t: { name: string }) => t.name === "send_message")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Sense/user_message → Motor/llm_request
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — user_message → llm_request", () => {
	it("emits llm_request when user_message arrives", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("hello");
		recorder.assertMotorEmitted("llm_request");
	});

	it("llm_request carries user text as message content", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("what time is it?");

		const req = recorder.assertMotorEmitted("llm_request");
		if (req.type !== "llm_request") throw new Error("wrong type");
		const msg = req.messages[0] as { role: string; content: string };
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("what time is it?");
	});

	it("llm_request carries the same correlationId as user_message", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const sense = recorder.assertSenseEmitted("user_message");
		const motor = recorder.assertMotorEmitted("llm_request");
		expect(motor.correlationId).toBe(sense.correlationId);
	});
});

// ---------------------------------------------------------------------------
// Motor/tool_call("send_message") → Motor/user_reply
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — send_message → user_reply", () => {
	it("emits user_reply when send_message tool_call arrives", async () => {
		const { corpus, recorder } = make("response text");
		await corpus.prompt("hi");
		recorder.assertMotorEmitted("user_reply");
	});

	it("user_reply carries the LLM canned text", async () => {
		const { corpus } = make("the answer is 42");
		const reply = await corpus.prompt("what is the answer?");
		expect(reply).toBe("the answer is 42");
	});

	it("user_reply carries the same correlationId as the tool_call", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const call = recorder.assertToolCallEmitted("send_message");
		const reply = recorder.assertMotorEmitted("user_reply");
		expect(reply.correlationId).toBe(call.correlationId);
	});

	it("ignores tool_calls for other tools", async () => {
		const { corpus, recorder } = make();
		// MockLLMOrgan only emits send_message, no other tool calls expected
		await corpus.prompt("hi");
		type ToolCall = Extract<(typeof recorder.motor)[number], { type: "tool_call" }>;
		const toolCalls = recorder.motor.filter(
			(e): e is ToolCall => e.type === "tool_call" && e.toolName !== "send_message",
		);
		expect(toolCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("TextMessageOrgan — full round-trip", () => {
	it("prompt resolves through the full Spine event chain", async () => {
		const { corpus } = make("pong");
		const reply = await corpus.prompt("ping");
		expect(reply).toBe("pong");
	});

	it("concurrent prompts resolve independently", async () => {
		const { corpus } = make("ok");
		const [a, b, c] = await Promise.all([corpus.prompt("one"), corpus.prompt("two"), corpus.prompt("three")]);
		expect([a, b, c]).toEqual(["ok", "ok", "ok"]);
	});

	it("full event sequence on all buses", async () => {
		const { corpus, recorder } = make("done");
		await corpus.prompt("start");

		const senseTypes = recorder.sense.map((e: { type: string }) => e.type);
		const motorTypes = recorder.motor.map((e: { type: string }) => e.type);
		expect(senseTypes).toContain("user_message");
		expect(motorTypes).toContain("llm_request");
		expect(motorTypes).toContain("tool_call");
		expect(motorTypes).toContain("user_reply");
	});
});
