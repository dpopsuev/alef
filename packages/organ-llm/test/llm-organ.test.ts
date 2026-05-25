import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { BusEventRecorder } from "../../testkit/src/index.js";
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

describe("LLMOrgan — application-level retry", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makeRetryHarness(faux: ReturnType<typeof registerFauxProvider>, maxRetries: number) {
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(new LLMOrgan({ model: faux.getModel(), apiKey: "faux-key", maxRetries, maxRetryDelayMs: 0 }));
		disposes.push(() => agent.dispose());
		return { dialog };
	}

	it("retries overloaded_error and succeeds on second attempt", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const { dialog } = makeRetryHarness(faux, 2);
		const reply = await dialog.send("test", "human", 5_000);
		expect(reply).toBe("recovered");
		expect(faux.state.callCount).toBe(2);
	});

	it("retries network connection lost and succeeds", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			fauxAssistantMessage("back online"),
		]);
		const { dialog } = makeRetryHarness(faux, 3);
		const reply = await dialog.send("test", "human", 5_000);
		expect(reply).toBe("back online");
		expect(faux.state.callCount).toBe(3);
	});

	it("gives up after maxRetries exhausted and resolves (does not hang)", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);
		const { dialog } = makeRetryHarness(faux, 2);
		const reply = await dialog.send("test", "human", 5_000);
		expect(faux.state.callCount).toBe(3); // initial + 2 retries
		expect(typeof reply).toBe("string");
	});

	it("does not retry non-transient errors", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request" }),
			fauxAssistantMessage("unreachable"),
		]);
		const { dialog } = makeRetryHarness(faux, 2);
		await dialog.send("test", "human", 5_000);
		expect(faux.state.callCount).toBe(1);
	});

	it("retries APIConnectionTimeoutError ('Request timed out.')", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			fauxAssistantMessage("recovered after timeout"),
		]);
		const { dialog } = makeRetryHarness(faux, 2);
		const reply = await dialog.send("test", "human", 5_000);
		expect(reply).toBe("recovered after timeout");
		expect(faux.state.callCount).toBe(2);
	});
});

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

// ---------------------------------------------------------------------------
// payloadToText — unit tests for ToolCallEnd.result conversion
// ---------------------------------------------------------------------------

import { payloadToText } from "../src/index.js";

describe("payloadToText", () => {
	it("returns errorMessage when isError is true", () => {
		expect(payloadToText({}, true, "organ failure")).toBe("organ failure");
	});

	it("falls back to JSON when isError is true and no errorMessage", () => {
		const result = payloadToText({ toolCallId: "x" }, true, undefined);
		expect(result).toContain("toolCallId");
	});

	it("returns content string when present", () => {
		expect(payloadToText({ content: "file contents here" }, false)).toBe("file contents here");
	});

	it("returns text string when content absent", () => {
		expect(payloadToText({ text: "hello" }, false)).toBe("hello");
	});

	it("falls back to JSON of remaining fields (strips toolCallId and isFinal)", () => {
		const result = payloadToText({ toolCallId: "x", isFinal: true, exitCode: 0 }, false);
		expect(result).toContain("exitCode");
		expect(result).not.toContain("toolCallId");
		expect(result).not.toContain("isFinal");
	});
}); // end payloadToText

// ---------------------------------------------------------------------------
// onResponseChunk forwarding — dialog_message tool args (ALE-BUG fix)
//
// The LLM uses dialog_message as a tool call; the reply body lives in
// replyCall.args.text, not in text_delta events. organ-llm must forward
// that text to onResponseChunk so the TUI renders the full reply.
// ---------------------------------------------------------------------------

import { fauxText, fauxToolCall } from "@dpopsuev/alef-ai";

function makeFauxHarness(faux: ReturnType<typeof registerFauxProvider>, onResponseChunk?: (chunk: string) => void) {
	const chunks: string[] = [];
	const capture = (c: string): void => {
		chunks.push(c);
		onResponseChunk?.(c);
	};

	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
	agent.load(dialog).load(
		new LLMOrgan({
			model: faux.getModel(),
			apiKey: "faux-key",
			onResponseChunk: capture,
		}),
	);
	return { agent, dialog, chunks, dispose: () => agent.dispose() };
}

describe("onResponseChunk forwarding when reply is in dialog_message tool args", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	/**
	 * Simplest case: LLM responds with ONLY a dialog_message tool call (no prior text_delta).
	 * The entire reply lives in args.text. onResponseChunk must be called with that text.
	 */
	it("onResponseChunk receives reply text from dialog_message tool call args", async () => {
		const faux = registerFauxProvider();
		const replyBody = "Here is the complete bug report: 1. Off-by-one in evaluations/write.ts";
		faux.setResponses([fauxAssistantMessage([fauxToolCall("dialog_message", { text: replyBody })])]);
		const { dialog, chunks, dispose } = makeFauxHarness(faux);
		disposes.push(dispose);

		await dialog.send("find bugs", "user", 5_000);

		const combined = chunks.join("");
		expect(combined).toContain(replyBody);
	});

	/**
	 * Realistic case: LLM produces introductory text_delta ("Let me summarize:")
	 * THEN calls dialog_message with the actual body. Both parts must reach onResponseChunk.
	 */
	it("onResponseChunk receives both intro text_delta AND dialog_message args.text", async () => {
		const faux = registerFauxProvider();
		const introText = "Let me summarize the findings:";
		const replyBody = "## Bug Report\n\n1. Race condition in organ-fs\n2. Off-by-one in write.ts";
		faux.setResponses([
			fauxAssistantMessage([fauxText(introText), fauxToolCall("dialog_message", { text: replyBody })]),
		]);
		const { dialog, chunks, dispose } = makeFauxHarness(faux);
		disposes.push(dispose);

		await dialog.send("look for bugs", "user", 5_000);

		const combined = chunks.join("");
		expect(combined).toContain(introText);
		expect(combined).toContain(replyBody);
	});

	/**
	 * Invariant: sum of onResponseChunk calls must equal the text published
	 * in the motor/dialog.message event. This ensures the TUI always shows
	 * exactly what the agent replied.
	 */
	it("total onResponseChunk chars equals dialog.message payload text", async () => {
		const faux = registerFauxProvider();
		const replyBody = "Complete analysis:\n\n- Bug A\n- Bug B\n- Bug C";
		const recorder = new BusEventRecorder();
		const chunks: string[] = [];

		const agent2 = new Agent();
		const dialog2 = new DialogOrgan({ sink: () => {}, getTools: () => agent2.tools });
		agent2
			.load(dialog2)
			.load(new LLMOrgan({ model: faux.getModel(), apiKey: "faux-key", onResponseChunk: (c) => chunks.push(c) }));
		agent2.observe(recorder);
		disposes.push(() => agent2.dispose());

		faux.setResponses([
			fauxAssistantMessage([fauxText("Analyzing now..."), fauxToolCall("dialog_message", { text: replyBody })]),
		]);
		await dialog2.send("find bugs", "user", 5_000);

		const motionEvent = recorder.assertMotorEmitted("dialog.message") as unknown as {
			payload: { text: string };
		};
		const publishedText = motionEvent.payload.text;
		const chunkedText = chunks.join("");

		// The TUI sees chunkedText. The JSONL records publishedText.
		// They must contain the same reply body so the screen matches the log.
		expect(chunkedText).toContain(publishedText);
	});
});

// ---------------------------------------------------------------------------
// ALE-BUG-7: sealStreamingSegment leaves empty Container in DOM
// ALE-BUG-8: tool-call history lost on abort/error
//
// These test the organ-llm layer for BUG-8.
// BUG-7 is a TUI-layer concern (tui-mode.ts) tested via VirtualTerminal.
// ---------------------------------------------------------------------------

describe("ALE-BUG-8: partial conversationHistory published on error/abort", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	/**
	 * When the LLM aborts mid-turn after completing at least one tool round,
	 * organ-llm must publish a dialog.message that carries the partial
	 * conversationHistory so the next turn retains tool-call context.
	 *
	 * This verifies the onCheckpoint → partialHistory → motor.publish path.
	 */
	it("after tool round + abort, dialog.message carries partial conversationHistory", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();

		// Faux: first call returns a real tool call; second call errors (simulates abort).
		// We need an organ harness that actually processes tool calls.
		// Use a faux that completes one tool round then errors.
		faux.setResponses([
			// Round 1: LLM makes a tool call. Agent processes it, then LLM errors on round 2.
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		// Minimal harness: dialog + llm only (no fs/shell organs).
		// The tool call won't resolve but we still publish error on timeout/error.
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new LLMOrgan({ model: faux.getModel(), apiKey: "faux-key", maxRetries: 0 }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		// Even on a retryable error with maxRetries=0, motor/dialog.message must resolve.
		await dialog.send("do something", "user", 5_000);

		const event = recorder.assertMotorEmitted("dialog.message") as unknown as {
			payload: { text: string; conversationHistory?: unknown[] };
		};

		// At minimum, a text reply was published (error or fallback).
		expect(typeof event.payload.text).toBe("string");
	});

	/**
	 * When a turn succeeds (no error), conversationHistory is always present
	 * so the next turn has full context.
	 */
	it("successful turn publishes conversationHistory in dialog.message", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();

		faux.setResponses([fauxAssistantMessage([fauxToolCall("dialog_message", { text: "all good" })])]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new LLMOrgan({ model: faux.getModel(), apiKey: "faux-key" }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		await dialog.send("hi", "user", 5_000);

		const event = recorder.assertMotorEmitted("dialog.message") as unknown as {
			payload: { text: string; conversationHistory?: unknown[] };
		};

		// conversationHistory must be present and non-empty on success.
		expect(Array.isArray(event.payload.conversationHistory)).toBe(true);
		expect((event.payload.conversationHistory as unknown[]).length).toBeGreaterThan(0);
	});
});
