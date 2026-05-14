import { Corpus } from "@dpopsuev/alef-corpus";
import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { BusEventRecorder, MockLLMOrgan } from "../src/index.js";

// ---------------------------------------------------------------------------
// Bridge organ — converts Sense/user_message → Motor/llm_request.
// Stand-in for TextMessageOrgan until that package is built.
// ---------------------------------------------------------------------------

function makeBridgeOrgan(): Organ {
	return {
		name: "bridge",
		tools: [],
		mount: (nerve: Nerve) => {
			const off = nerve.sense.on("user_message", (event) => {
				if (event.type !== "user_message") return;
				nerve.motor.emit({
					type: "llm_request",
					messages: [{ role: "user", content: event.text }],
					tools: event.tools,
					correlationId: event.correlationId,
					timestamp: Date.now(),
				});
			});
			return off;
		},
	};
}

// Converts Motor/tool_call("send_message") → Motor/user_reply.
// Stand-in for the send_message handling in TextMessageOrgan.
function makeSendMessageOrgan(): Organ {
	return {
		name: "send-message-handler",
		tools: [{ name: "send_message", description: "Send text to user", inputSchema: { type: "object" as const } }],
		mount: (nerve: Nerve) => {
			const off = nerve.motor.on("tool_call", (event) => {
				if (event.type !== "tool_call" || event.toolName !== "send_message") return;
				const text = typeof event.args["text"] === "string" ? event.args["text"] : "";
				nerve.motor.emit({
					type: "user_reply",
					text,
					correlationId: event.correlationId,
					timestamp: Date.now(),
				});
			});
			return off;
		},
	};
}

// ---------------------------------------------------------------------------
// Harness factory — the pattern we'll formalise once TextMessageOrgan exists.
// ---------------------------------------------------------------------------

interface Harness {
	corpus: Corpus;
	recorder: BusEventRecorder;
	dispose(): void;
}

function createHarness(cannedText = "mock response"): Harness {
	const recorder = new BusEventRecorder();
	const corpus = new Corpus({ timeoutMs: 1000 });
	corpus.load(recorder).load(makeBridgeOrgan()).load(new MockLLMOrgan(cannedText)).load(makeSendMessageOrgan());
	return {
		corpus,
		recorder,
		dispose: () => corpus.dispose(),
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make(cannedText?: string): Harness {
	const h = createHarness(cannedText);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// MockLLMOrgan
// ---------------------------------------------------------------------------

describe("MockLLMOrgan", () => {
	it("emits tool_call(send_message) in response to llm_request", async () => {
		const { corpus, recorder } = make("hello from mock");
		await corpus.prompt("hi");

		const call = recorder.assertToolCallEmitted("send_message");
		expect(call.args["text"]).toBe("hello from mock");
	});

	it("carries correlationId from llm_request to tool_call", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("test");

		const req = recorder.assertMotorEmitted("llm_request");
		const call = recorder.assertToolCallEmitted("send_message");
		expect(call.correlationId).toBe(req.correlationId);
	});

	it("canned text is configurable", async () => {
		const { corpus } = make("custom reply");
		const reply = await corpus.prompt("anything");
		expect(reply).toBe("custom reply");
	});
});

// ---------------------------------------------------------------------------
// BusEventRecorder
// ---------------------------------------------------------------------------

describe("BusEventRecorder", () => {
	it("records Sense/user_message", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertSenseEmitted("user_message");
	});

	it("records Motor/llm_request", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertMotorEmitted("llm_request");
	});

	it("records Motor/tool_call", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertToolCallEmitted("send_message");
	});

	it("records Motor/user_reply", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");
		recorder.assertMotorEmitted("user_reply");
	});

	it("assertCorrelationPaired passes when both buses carry the correlationId", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("ping");

		const msg = recorder.assertSenseEmitted("user_message");
		expect(() => recorder.assertCorrelationPaired(msg.correlationId)).not.toThrow();
	});

	it("assertSenseEmitted throws with helpful message when event missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertSenseEmitted("tool_result")).toThrow("Expected Sense/tool_result");
	});

	it("assertMotorEmitted throws with helpful message when event missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertMotorEmitted("user_reply")).toThrow("Expected Motor/user_reply");
	});

	it("assertToolCallEmitted throws with helpful message when tool missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertToolCallEmitted("bash")).toThrow('Expected Motor/tool_call("bash")');
	});

	it("clear() resets all recorded events", async () => {
		const { corpus, recorder } = make();
		await corpus.prompt("first");
		recorder.clear();
		expect(recorder.sense).toHaveLength(0);
		expect(recorder.motor).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Harness round-trip
// ---------------------------------------------------------------------------

describe("createHarness round-trip", () => {
	it("corpus.prompt() resolves with MockLLMOrgan canned text", async () => {
		const { corpus } = make("pong");
		const reply = await corpus.prompt("ping");
		expect(reply).toBe("pong");
	});

	it("full event sequence: user_message → llm_request → tool_call → user_reply", async () => {
		const { corpus, recorder } = make("done");
		await corpus.prompt("start");

		const sense = recorder.sense.map((e) => e.type);
		const motor = recorder.motor.map((e) => e.type);

		expect(sense).toContain("user_message");
		expect(motor).toContain("llm_request");
		expect(motor).toContain("tool_call");
		expect(motor).toContain("user_reply");
	});
});
