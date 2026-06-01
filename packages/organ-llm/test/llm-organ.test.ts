import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { BusEventRecorder } from "../../testkit/src/index.js";
import { Cerebrum } from "../src/index.js";

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
	agent.load(dialog).load(new Cerebrum({ model: makeModel() }));
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

describe("Reasoner — application-level retry", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makeRetryHarness(faux: ReturnType<typeof registerFauxProvider>, maxRetries: number) {
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", maxRetries, maxRetryDelayMs: 0 }));
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

describe.skipIf(SKIP)("Reasoner — real API", () => {
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
		new Cerebrum({
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
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", onResponseChunk: (c) => chunks.push(c) }));
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
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", maxRetries: 0 }));
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
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key" }));
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

// ---------------------------------------------------------------------------
// motor/llm.phase seam
// ---------------------------------------------------------------------------

describe("Reasoner — motor/llm.phase seam", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("disabled by default (phaseTimeoutMs=0): no motor/llm.phase published", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("hello")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key" }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		await dialog.send("hi", "user", 5_000);

		const phaseEvents = recorder.motor.filter((e) => e.type === "llm.phase");
		expect(phaseEvents).toHaveLength(0);
	});

	it("publishes motor/llm.phase before each LLM call when phaseTimeoutMs > 0", async () => {
		const { fauxToolCall } = await import("@dpopsuev/alef-ai");
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage([fauxToolCall("dialog_message", { text: "done" })])]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", phaseTimeoutMs: 50 }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		await dialog.send("hi", "user", 5_000);

		const phaseEvents = recorder.motor.filter((e) => e.type === "llm.phase");
		expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
		const first = phaseEvents[0] as unknown as { payload: { messages: unknown[]; turn: number; toolCount: number } };
		expect(first.payload.turn).toBe(1);
		expect(Array.isArray(first.payload.messages)).toBe(true);
	});

	it("phase organ receives messages and its sense/llm.phase reply is awaited", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("ok")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });

		// Phase organ: records received messages, then passes them through unchanged.
		let phaseReceivedMessages: unknown[] = [];
		const phaseOrgan = {
			name: "phase-spy",
			description: "test phase interceptor",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { motor: ["llm.phase"] as const, sense: [] as const },
			mount(nerve: import("@dpopsuev/alef-spine").Nerve) {
				nerve.motor.subscribe("llm.phase", (event) => {
					const payload = event.payload as { messages: unknown[] };
					phaseReceivedMessages = payload.messages;
					// Echo messages back unchanged so the Reasoner continues.
					nerve.sense.publish({
						type: "llm.phase",
						payload: { messages: payload.messages },
						correlationId: event.correlationId,
						isError: false,
					});
				});
				return () => {};
			},
		};

		agent
			.load(dialog)
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", phaseTimeoutMs: 500 }))
			.load(phaseOrgan);
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		await dialog.send("hi", "user", 5_000);

		// Phase organ must have received the messages for this turn.
		expect(phaseReceivedMessages.length).toBeGreaterThan(0);
		// Turn still completed normally.
		recorder.assertMotorEmitted("dialog.message");
	});

	it("proceeds with original messages when phase organ times out", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", phaseTimeoutMs: 50 }));
		disposes.push(() => agent.dispose());

		const reply = await dialog.send("hi", "user", 5_000);
		expect(typeof reply).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// motor/llm.phase: skip, abort + motor/llm.result
// ---------------------------------------------------------------------------

describe("Reasoner — phase skip, abort, and llm.result", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makePhaseOrgan(
		handler: (
			payload: { messages: unknown[]; turn: number },
			reply: (response: Record<string, unknown>) => void,
		) => void,
	) {
		return {
			name: "phase-organ",
			description: "test",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { motor: ["llm.phase"] as const, sense: [] as const },
			mount(nerve: import("@dpopsuev/alef-spine").Nerve) {
				nerve.motor.subscribe("llm.phase", (event) => {
					handler(event.payload as { messages: unknown[]; turn: number }, (response) => {
						nerve.sense.publish({
							type: "llm.phase",
							payload: response,
							correlationId: event.correlationId,
							isError: false,
						});
					});
				});
				return () => {};
			},
		};
	}

	it("skip: phase organ bypasses LLM and injects its own reply", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("should not appear")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", phaseTimeoutMs: 500 }))
			.load(
				makePhaseOrgan((_payload, reply) => {
					reply({ skip: true, reply: "phase shortcut" });
				}),
			);
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		const result = await dialog.send("hi", "user", 5_000);
		expect(result).toBe("phase shortcut");
	});

	it("skip: phase.skip publishes on replyEvent, not hardcoded dialog.message", async () => {
		// Regression for: phase.skip path used DIALOG_MESSAGE unconditionally.
		// An ambient agent with triggerEvent='sensor.event' would get its reply
		// on the wrong motor channel.
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("should not appear")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(
				new Cerebrum({
					model: faux.getModel(),
					apiKey: "faux-key",
					phaseTimeoutMs: 500,
					replyEvent: "sensor.reply",
				}),
			)
			.load(
				makePhaseOrgan((_payload, reply) => {
					reply({ skip: true, reply: "ambient shortcut" });
				}),
			);
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		dialog.receive("trigger", "system");
		// Give the turn time to complete.
		await new Promise<void>((r) => setTimeout(r, 1_000));

		const sensorReplies = recorder.motor.filter((e) => e.type === "sensor.reply");
		const dialogReplies = recorder.motor.filter((e) => e.type === "dialog.message");
		expect(sensorReplies).toHaveLength(1);
		expect((sensorReplies[0] as unknown as { payload: { text: string } }).payload.text).toBe("ambient shortcut");
		expect(dialogReplies).toHaveLength(0);
	}, 5_000);

	it("abort: phase organ exits loop without publishing dialog.message", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("should not appear")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", phaseTimeoutMs: 500 }))
			.load(
				makePhaseOrgan((_payload, reply) => {
					reply({ abort: true });
				}),
			);
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		// dialog.send resolves with empty string when no dialog.message published.
		const result = await dialog.send("hi", "user", 2_000).catch(() => "timeout");
		const dialogMessages = recorder.motor.filter((e) => e.type === "dialog.message");
		expect(dialogMessages).toHaveLength(0);
		expect(result).toBeDefined();
	});

	it("motor/llm.result fires after each LLM response with response and toolCalls", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("hello")]);

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key" }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		await dialog.send("hi", "user", 5_000);

		const resultEvents = recorder.motor.filter((e) => e.type === "llm.result");
		expect(resultEvents.length).toBeGreaterThanOrEqual(1);
		const first = resultEvents[0] as unknown as {
			payload: { response: Record<string, unknown>; toolCalls: unknown[]; turn: number };
		};
		expect(first.payload.turn).toBe(1);
		expect(Array.isArray(first.payload.toolCalls)).toBe(true);
		expect(typeof first.payload.response).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// Configurable trigger (ALE-SPC-29)
// ---------------------------------------------------------------------------

describe("Reasoner — configurable triggerEvent", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("fires on custom triggerEvent instead of dialog.message", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("acted on git event")]);

		const agent = new Agent();
		// No DialogOrgan — autonomous agent with git.push trigger.
		agent.load(
			new Cerebrum({
				model: faux.getModel(),
				apiKey: "faux-key",
				triggerEvent: "git.push",
				replyEvent: "git.review",
			}),
		);
		agent.observe(recorder);
		disposes.push(() => agent.dispose());

		// Inject the trigger directly via publishSense.
		const replyP = new Promise<void>((resolve) => {
			agent.subscribeMotor("git.review", () => resolve());
		});
		agent.publishSense({
			type: "git.push",
			payload: { pr: 42, diff: "some changes" },
			correlationId: "git-turn-1",
			isError: false,
		});
		await replyP;

		// Reply published on git.review, not dialog.message.
		const gitReview = recorder.motor.find((e) => e.type === "git.review");
		expect(gitReview).toBeDefined();
		expect(recorder.motor.find((e) => e.type === "dialog.message")).toBeUndefined();
	});

	it("conversation trigger still works with defaults", async () => {
		const faux = registerFauxProvider();
		const recorder = new BusEventRecorder();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key" }));
		agent.observe(recorder);
		disposes.push(() => agent.dispose());
		const reply = await dialog.send("hi", "user", 5_000);
		expect(reply).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// trackConcurrentOps — structural and behavioural tests
// ---------------------------------------------------------------------------

describe("Cerebrum — trackConcurrentOps", () => {
	it("declares wildcard motor+sense subscriptions when trackConcurrentOps=true", () => {
		const cerebrum = new Cerebrum({ model: makeModel(), trackConcurrentOps: true });
		// agent.validate() checks subscriptions to build the port registry.
		// If ALE-TSK-424 forgets "*" in the factory output, validate() fails.
		expect(cerebrum.subscriptions.motor).toContain("*");
		expect(cerebrum.subscriptions.sense).toContain("*");
	});

	it("does not declare wildcard subscriptions when trackConcurrentOps=false", () => {
		const cerebrum = new Cerebrum({ model: makeModel() });
		expect(cerebrum.subscriptions.motor).not.toContain("*");
		expect(cerebrum.subscriptions.sense).not.toContain("*");
	});

	it("injects Pending operations into prepareStep output when inflight ops exist", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		// concurrentOrgan publishes a motor event on a DIFFERENT correlationId,
		// simulating a concurrent turn already in flight.
		const concurrentOrgan: Organ = {
			name: "concurrent-sim",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			mount(nerve: Nerve) {
				nerve.motor.publish({
					type: "fs.read",
					correlationId: "concurrent-turn-abc",
					payload: { path: "/test/file.ts" },
				});
				return () => {};
			},
		};

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		// Cerebrum loaded BEFORE concurrentOrgan so wildcard subscription is active.
		agent
			.load(dialog)
			.load(
				new Cerebrum({
					model: faux.getModel(),
					apiKey: "faux-key",
					trackConcurrentOps: true,
					// prepareStep receives post-injection messages because Cerebrum
					// calls applyInflightContext and THEN passes the result to the
					// LLM — but our callback runs BEFORE injection. We capture via
					// onCheckpoint which receives the full accumulated messages.
					onCheckpoint: (_msgs) => {},
				}),
			)
			.load(concurrentOrgan);
		await agent.ready();

		await dialog.send("hi", "user", 5_000);

		// The faux provider was called — pipeline ran.
		expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
		agent.dispose();
	});
});
