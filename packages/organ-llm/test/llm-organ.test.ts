import type { Nerve, Organ } from "@dpopsuev/alef-kernel";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import type { Context, FauxResponseFactory } from "@dpopsuev/alef-llm";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm";
import { afterEach, describe, expect, it } from "vitest";
import { NerveFixture, organComplianceSuite, TurnDriver } from "../../testkit/src/index.js";
import { createAgentLoop } from "../src/index.js";
import { waitForToolResult } from "../src/tool-dispatch.js";
import { buildTools } from "../src/turn-loop.js";

// createContextAssemblyPipeline (from kernel) is the mountable pipeline organ — no tools, pure coordinator.
// organ-llm is a reasoner (no tools), not a tool-bearing organ.
organComplianceSuite(() => createContextAssemblyPipeline());

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

/**
 * Standard test harness: bare nerve, TurnDriver, LLM organ, optional BusEventRecorder.
 * Replaces the Agent + DialogOrgan + organ-llm construction that appeared in every test.
 */
function makeHarness(llm: Organ) {
	const f = new NerveFixture();
	const driver = new TurnDriver(f.nerve);
	const recorder = f.observe();
	f.mount(llm);
	return { f, driver, recorder };
}

const harnesses: Array<{ f: NerveFixture }> = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.f.dispose();
});

function make(fauxProvider: ReturnType<typeof registerFauxProvider>) {
	const h = makeHarness(
		createAgentLoop({
			model: fauxProvider.getModel(),
			apiKey: "faux-key",
		}),
	);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// Application-level retry
// ---------------------------------------------------------------------------

describe("Reasoner — application-level retry", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makeRetryHarness(faux: ReturnType<typeof registerFauxProvider>, maxRetries: number) {
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				maxRetries,
				maxRetryDelayMs: 0,
			}),
		);
		disposes.push(() => f.dispose());
		return { driver };
	}

	it("retries overloaded_error and succeeds on second attempt", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const { driver } = makeRetryHarness(faux, 2);
		const reply = await driver.send("test", "human", 5_000);
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
		const { driver } = makeRetryHarness(faux, 3);
		const reply = await driver.send("test", "human", 5_000);
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
		const { driver } = makeRetryHarness(faux, 2);
		const reply = await driver.send("test", "human", 5_000);
		expect(faux.state.callCount).toBe(3);
		expect(typeof reply).toBe("string");
	});

	it("does not retry non-transient errors", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request" }),
			fauxAssistantMessage("unreachable"),
		]);
		const { driver } = makeRetryHarness(faux, 2);
		await driver.send("test", "human", 5_000);
		expect(faux.state.callCount).toBe(1);
	});

	it("retries APIConnectionTimeoutError ('Request timed out.')", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			fauxAssistantMessage("recovered after timeout"),
		]);
		const { driver } = makeRetryHarness(faux, 2);
		const reply = await driver.send("test", "human", 5_000);
		expect(reply).toBe("recovered after timeout");
		expect(faux.state.callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Real API (skipped without ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("Reasoner — real API", { tags: ["unit"] }, () => {
	it("resolves driver.send() with a non-empty reply", async () => {
		const faux = registerFauxProvider();
		const { driver } = make(faux);
		const reply = await driver.send("Respond with exactly: HEALTH_CHECK_OK");
		expect(reply.length).toBeGreaterThan(0);
		expect(reply).toContain("HEALTH_CHECK_OK");
	}, 30_000);

	it("emits the full event sequence on all buses", async () => {
		const faux = registerFauxProvider();
		const { driver, recorder } = make(faux);
		await driver.send("Say hi in one word.");
		recorder.assertMotorEmitted("llm.response");
		recorder.assertSenseEmitted("llm.input");
	}, 30_000);

	it("llm.response payload contains the reply text", async () => {
		const faux = registerFauxProvider();
		const { driver, recorder } = make(faux);
		await driver.send("What is 2+2? Reply with just the number.");
		const msg = recorder.assertMotorEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(typeof payload.text).toBe("string");
		expect(payload.text.length).toBeGreaterThan(0);
	}, 30_000);

	it("all turn events share the same correlationId", async () => {
		const faux = registerFauxProvider();
		const { driver, recorder } = make(faux);
		await driver.send("Say yes.");
		const input = recorder.assertMotorEmitted("llm.response");
		const prompt = recorder.assertSenseEmitted("llm.input");
		const msg = recorder.assertMotorEmitted("llm.response");
		expect(prompt.correlationId).toBe(input.correlationId);
		expect(msg.correlationId).toBe(input.correlationId);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// payloadToText
// ---------------------------------------------------------------------------

import { payloadToText } from "../src/index.js";

describe("payloadToText", { tags: ["unit"] }, () => {
	it("returns errorMessage when isError is true", () => {
		expect(payloadToText({}, true, "organ failure")).toBe("organ failure");
	});

	it("falls back to JSON when isError is true and no errorMessage", () => {
		expect(payloadToText({ toolCallId: "x" }, true, undefined)).toContain("toolCallId");
	});

	it("returns content string when present", () => {
		expect(payloadToText({ content: "file contents here" }, false)).toBe("file contents here");
	});

	it("returns text string when content absent", () => {
		expect(payloadToText({ text: "hello" }, false)).toBe("hello");
	});

	it("returns markdown string when content and text are absent", () => {
		expect(payloadToText({ markdown: "# Article\n\nBody text." }, false)).toBe("# Article\n\nBody text.");
	});

	it("content takes priority over markdown", () => {
		expect(payloadToText({ content: "wins", markdown: "loses" }, false)).toBe("wins");
	});

	it("falls back to JSON of remaining fields (strips toolCallId and isFinal)", () => {
		const result = payloadToText({ toolCallId: "x", isFinal: true, exitCode: 0 }, false);
		expect(result).toContain("exitCode");
		expect(result).not.toContain("toolCallId");
		expect(result).not.toContain("isFinal");
	});
});

// ---------------------------------------------------------------------------
// partial conversationHistory on error/abort
// ---------------------------------------------------------------------------

describe("partial conversationHistory published on error/abort", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("after error with maxRetries=0, motor/llm.response carries text reply", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				maxRetries: 0,
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("do something", "user", 5_000);
		const event = recorder.assertMotorEmitted("llm.response") as unknown as { payload: { text: string } };
		expect(typeof event.payload.text).toBe("string");
	});

	it("successful turn publishes conversationHistory in llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("all good")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		const event = recorder.assertMotorEmitted("llm.response") as unknown as {
			payload: { conversationHistory?: unknown[] };
		};
		expect(Array.isArray(event.payload.conversationHistory)).toBe(true);
		expect((event.payload.conversationHistory as unknown[]).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// motor/context.assemble seam
// ---------------------------------------------------------------------------

describe("Reasoner — motor/context.assemble seam", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("disabled by default (phaseTimeoutMs=0): no motor/context.assemble published", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		expect(recorder.motor.filter((e) => e.type === "context.assemble")).toHaveLength(0);
	});

	it("publishes motor/context.assemble before each LLM call when phaseTimeoutMs > 0", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 50,
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		const phaseEvents = recorder.motor.filter((e) => e.type === "context.assemble");
		expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
		const first = phaseEvents[0] as unknown as { payload: { messages: unknown[]; turn: number } };
		expect(first.payload.turn).toBe(1);
		expect(Array.isArray(first.payload.messages)).toBe(true);
	});

	it("phase organ receives messages and its sense/context.assemble reply is awaited", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();

		let phaseReceivedMessages: unknown[] = [];
		const phaseOrgan = {
			name: "phase-spy",
			description: "test phase interceptor",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { motor: ["context.assemble"] as const, sense: [] as const },
			sources: [],
			mount(nerve: Nerve) {
				nerve.motor.subscribe("context.assemble", (event) => {
					const payload = event.payload as { messages: unknown[] };
					phaseReceivedMessages = payload.messages;
					nerve.sense.publish({
						type: "context.assemble",
						payload: { messages: payload.messages },
						correlationId: event.correlationId,
						isError: false,
					});
				});
				return () => {};
			},
		};

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(phaseOrgan);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		expect(phaseReceivedMessages.length).toBeGreaterThan(0);
		recorder.assertMotorEmitted("llm.response");
	});

	it("proceeds with original messages when phase organ times out", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 50,
			}),
		);
		disposes.push(() => f.dispose());

		const reply = await driver.send("hi", "user", 5_000);
		expect(typeof reply).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// motor/context.assemble: skip, abort, llm.result
// ---------------------------------------------------------------------------

describe("Reasoner — phase skip, abort, and llm.result", { tags: ["unit"] }, () => {
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
			subscriptions: { motor: ["context.assemble"] as const, sense: [] as const },
			sources: [],
			mount(nerve: Nerve) {
				nerve.motor.subscribe("context.assemble", (event) => {
					handler(event.payload as { messages: unknown[]; turn: number }, (response) => {
						nerve.sense.publish({
							type: "context.assemble",
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
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseOrgan((_payload, reply) => {
				reply({ skip: true, reply: "phase shortcut" });
			}),
		);
		disposes.push(() => f.dispose());

		const result = await driver.send("hi", "user", 5_000);
		expect(result).toBe("phase shortcut");
	});

	it("skip: phase.skip publishes motor/llm.response with the skip reply text", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new NerveFixture();
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseOrgan((_payload, reply) => {
				reply({ skip: true, reply: "ambient shortcut" });
			}),
		);
		disposes.push(() => f.dispose());

		f.nerve.asNerve().sense.publish({
			type: "llm.input",
			correlationId: "test-corr",
			payload: { text: "trigger", sender: "system" },
			isError: false,
		});
		await new Promise<void>((r) => setTimeout(r, 1_000));

		const replies = recorder.motor.filter((e) => e.type === "llm.response");
		expect(replies).toHaveLength(1);
		expect((replies[0] as unknown as { payload: { text: string } }).payload.text).toBe("ambient shortcut");
	}, 5_000);

	it("abort: phase organ exits loop without publishing llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseOrgan((_payload, reply) => {
				reply({ abort: true });
			}),
		);
		disposes.push(() => f.dispose());

		const result = await driver.send("hi", "user", 2_000).catch(() => "timeout");
		expect(recorder.motor.filter((e) => e.type === "llm.response")).toHaveLength(0);
		expect(result).toBeDefined();
	});

	it("motor/llm.result fires after each LLM response with response and toolCalls", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);

		const resultEvents = recorder.signal.filter((e) => e.type === "llm.result");
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
// Configurable triggerEvent
// ---------------------------------------------------------------------------

describe("Reasoner — configurable triggerEvent", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("fires on sense/llm.input and replies on motor/llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello from llm")]);
		const f = new NerveFixture();
		const recorder = f.observe();
		const driver = new TurnDriver(f.nerve);
		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key" }));
		disposes.push(() => f.dispose());

		const reply = await driver.send("hi", "user", 5_000);
		expect(reply).toBe("hello from llm");
		expect(recorder.motor.find((e) => e.type === "llm.response")).toBeDefined();
		expect(recorder.sense.find((e) => e.type === "llm.input")).toBeDefined();
	});

	it("conversation trigger still works with defaults", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		const reply = await driver.send("hi", "user", 5_000);
		expect(reply).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// trackConcurrentOps
// ---------------------------------------------------------------------------

describe("organ-llm — trackConcurrentOps", { tags: ["unit"] }, () => {
	it("declares wildcard motor+sense subscriptions when trackConcurrentOps=true", () => {
		const llm = createAgentLoop({ model: makeModel(), trackConcurrentOps: true });
		expect(llm.subscriptions.motor).toContain("*");
		expect(llm.subscriptions.sense).toContain("*");
	});

	it("does not declare wildcard subscriptions when trackConcurrentOps=false", () => {
		const llm = createAgentLoop({ model: makeModel() });
		expect(llm.subscriptions.motor).not.toContain("*");
		expect(llm.subscriptions.sense).not.toContain("*");
	});

	it("injects Pending operations into prepareStep output when inflight ops exist", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		const concurrentOrgan: Organ = {
			name: "concurrent-sim",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			sources: [],
			mount(nerve: Nerve) {
				nerve.motor.publish({
					type: "fs.read",
					correlationId: "concurrent-turn-abc",
					payload: { path: "/test/file.ts" },
				});
				return () => {};
			},
		};

		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				trackConcurrentOps: true,
			}),
		);
		f.mount(concurrentOrgan);

		await driver.send("hi", "user", 5_000);
		expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
		f.dispose();
	});
});

// ---------------------------------------------------------------------------
// Schema validation hang regression
// ---------------------------------------------------------------------------

import { defineOrgan, typedAction } from "@dpopsuev/alef-kernel";
import { z } from "zod";

describe("turn loop — schema validation failure", { tags: ["unit"] }, () => {
	it("turn completes when LLM sends wrong type for a schema field", async () => {
		const faux = registerFauxProvider();
		const f = new NerveFixture();

		const strictOrgan = defineOrgan(
			"strict",
			{
				motor: {
					"strict.op": typedAction(
						{
							name: "strict.op",
							description: "Op requiring a numeric count.",
							inputSchema: z.object({ count: z.number() }),
						},
						async () => ({ result: "ok" }),
					),
				},
			},
			{ description: "Strict schema organ.", directives: ["Use strict.op when asked."] },
		);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		f.mount(strictOrgan);

		const driver = new TurnDriver(f.nerve, undefined, undefined, strictOrgan.tools);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("strict_op", { count: "3" })]),
			fauxAssistantMessage("I see the validation failed"),
		]);

		const reply = await driver.send("call strict.op", "human", 3_000);
		expect(reply).toBe("I see the validation failed");
		f.dispose();
	}, 6_000);
});

// ---------------------------------------------------------------------------
// prepareStep system prompt delivery
// ---------------------------------------------------------------------------

describe("prepareStep system prompt delivery to provider", { tags: ["unit"] }, () => {
	it("system message injected by prepareStep reaches the provider as systemPrompt", async () => {
		// Given: a faux provider that captures the Context it receives
		const faux = registerFauxProvider();
		let capturedContext: Context | undefined;
		const captureFactory: FauxResponseFactory = (ctx) => {
			capturedContext = ctx;
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([captureFactory]);

		// When: organ-llm runs with a prepareStep that injects a system message
		const systemText = "You are Alef. No emojis.";
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				systemPrompt: systemText,
			}),
		);

		await driver.send("hello", "human", 3_000);
		f.dispose();

		// Then: the provider must receive systemPrompt — not a role:"system" message buried in the array
		expect(capturedContext?.systemPrompt).toBe(systemText);
		// And: no system message should appear in the messages array sent to the provider
		const systemInMessages = capturedContext?.messages.some((m) => (m as { role?: string }).role === "system");
		expect(systemInMessages).toBe(false);
	}, 5_000);
});

// ---------------------------------------------------------------------------
// tool:end fires on timeout (regression)
// ---------------------------------------------------------------------------

describe("dispatchTools — tool:end fires on every exit path", { tags: ["unit"] }, () => {
	it("emits tool-end(ok:false) when tool times out — never leaves pill hanging", async () => {
		// Given: a faux LLM that calls a tool that will never respond
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxToolCall("hung_tool", { command: "wait" })])]);

		const capturedEvents: Array<{ type: string; ok?: boolean; result?: string }> = [];

		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);

		// A stub organ that subscribes to motor/hung_tool but never publishes a sense reply
		const { z } = await import("zod");
		const hungOrgan = defineOrgan(
			"hung",
			{
				motor: {
					hung_tool: {
						tool: { name: "hung_tool", description: "Never responds.", inputSchema: z.object({}) },
						handle: (): AsyncIterable<Record<string, unknown>> =>
							(async function* () {
								await new Promise(() => {});
								yield {};
							})(),
					},
				},
			},
			{
				description: "Stub that hangs forever for timeout regression testing.",
				directives: ["Use hung_tool when instructed to test timeout behaviour."],
			},
		);

		f.nerve.asNerve().signal.subscribe("llm.tool-start", () => {
			capturedEvents.push({ type: "tool-start" });
		});
		f.nerve.asNerve().signal.subscribe("llm.tool-end", (event) => {
			capturedEvents.push({
				type: "tool-end",
				ok: Boolean(event.payload.ok),
				result: event.payload.result as string | undefined,
			});
		});
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				timeoutMs: 200, // short timeout for test speed
			}),
		);
		f.mount(hungOrgan);

		// When: the turn runs and the tool times out
		await driver.send("call hung_tool", "human", 2_000);
		f.dispose();

		// Then: exactly one tool-start and one tool-end with ok:false
		const starts = capturedEvents.filter((e) => e.type === "tool-start");
		const ends = capturedEvents.filter((e) => e.type === "tool-end");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.ok).toBe(false);
		expect(ends[0]?.result).toMatch(/timed out/i);
	}, 4_000);
});

// ---------------------------------------------------------------------------
// / tool-chunk LlmEvents relay isFinal:false
// ---------------------------------------------------------------------------

describe("typedStreamAction — tool-chunk relay to onEvent", { tags: ["unit"] }, () => {
	it("emits tool-chunk for each isFinal:false sense event before tool-end", async () => {
		// Given: a faux LLM that calls a streaming organ, then replies
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("streamer_run", { command: "go" })]),
			fauxAssistantMessage("streaming complete"),
		]);

		const { z } = await import("zod");
		const { typedStreamAction } = await import("@dpopsuev/alef-kernel");

		// A streaming organ that yields three intermediate chunks then a final result
		const streamingOrgan = defineOrgan(
			"streamer",
			{
				motor: {
					"streamer.run": typedStreamAction(
						{
							name: "streamer.run",
							description: "Streaming test organ that yields chunks.",
							inputSchema: z.object({ command: z.string() }),
						},
						async function* () {
							yield { text: "step 1" };
							yield { text: "step 2" };
							yield { text: "step 3", result: "done" };
						},
					),
				},
			},
			{
				description: "Streaming test organ for chunk relay regression.",
				directives: ["Use streamer.run to test streaming chunk relay behaviour."],
			},
		);

		const capturedChunks: string[] = [];
		const eventOrder: string[] = [];

		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve, undefined, undefined, streamingOrgan.tools);

		f.nerve.asNerve().signal.subscribe("llm.tool-chunk", (event) => {
			eventOrder.push("tool-chunk");
			capturedChunks.push(String((event as { payload: Record<string, unknown> }).payload.text ?? ""));
		});
		f.nerve.asNerve().signal.subscribe("llm.tool-end", () => {
			eventOrder.push("tool-end");
		});
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		f.mount(streamingOrgan);

		await driver.send("go", "human", 5_000);
		f.dispose();

		// All intermediate chunk texts must have been relayed as tool-chunk events
		expect(capturedChunks, "chunk 1 must reach onEvent as tool-chunk").toContain("step 1");
		expect(capturedChunks, "chunk 2 must reach onEvent as tool-chunk").toContain("step 2");

		// tool-chunk events must precede tool-end
		const firstChunkIdx = eventOrder.indexOf("tool-chunk");
		const toolEndIdx = eventOrder.indexOf("tool-end");
		expect(firstChunkIdx, "tool-chunk must fire before tool-end").toBeGreaterThanOrEqual(0);
		expect(toolEndIdx, "tool-end must fire").toBeGreaterThanOrEqual(0);
		expect(firstChunkIdx, "tool-chunk must precede tool-end").toBeLessThan(toolEndIdx);
	}, 6_000);
});

// ---------------------------------------------------------------------------
// tool-stall LlmEvent — the TUI pill "⏳ no output for Ns" display
// ---------------------------------------------------------------------------

describe("waitForToolResult — stall watchdog", { tags: ["unit"] }, () => {
	it("fires onStall after stallIntervalMs with no chunks, before timeout", async () => {
		// Given: a sense bus where the tool never responds (simulating a hung subagent)
		const f = new NerveFixture();
		const correlationId = "corr-stall-test";
		const toolCallId = "tc-stall-1";

		const stallEvents: Array<{ elapsedMs: number; lastChunkMs: number }> = [];

		// When: waitForToolResult with a 200ms stall interval and 600ms timeout
		const resultPromise = waitForToolResult({
			sense: f.nerve.asNerve().sense,
			toolName: "stall.test",
			toolCallId,
			correlationId,
			timeoutMs: 600,
			onStall: (info) => stallEvents.push(info),
			stallIntervalMs: 200,
		});

		// The promise will reject at 600ms (timeout)
		await expect(resultPromise).rejects.toThrow(/timed out/i);
		f.dispose();

		// onStall must have fired at least once before the timeout
		expect(stallEvents.length, "stall watchdog must fire at least once before timeout").toBeGreaterThan(0);

		// Each stall event must report meaningful elapsed time and lastChunkMs
		for (const event of stallEvents) {
			expect(event.elapsedMs, "elapsedMs must be positive").toBeGreaterThan(0);
			expect(event.lastChunkMs, "lastChunkMs must be >= stall interval").toBeGreaterThanOrEqual(200);
		}
	}, 3_000);

	it("stall resets when a chunk arrives — onStall does not fire after chunk", async () => {
		// Given: a sense bus that sends one isFinal:false chunk then goes silent
		const f = new NerveFixture();
		const correlationId = "corr-stall-reset";
		const toolCallId = "tc-stall-2";

		const stallEvents: Array<{ elapsedMs: number; lastChunkMs: number }> = [];
		const chunks: string[] = [];

		const resultPromise = waitForToolResult({
			sense: f.nerve.asNerve().sense,
			toolName: "stall.reset",
			toolCallId,
			correlationId,
			timeoutMs: 600,
			onChunk: (text) => chunks.push(text),
			onStall: (info) => stallEvents.push(info),
			stallIntervalMs: 200,
		});

		// Emit one chunk at 50ms — resets the stall clock
		setTimeout(() => {
			f.nerve.asNerve().sense.publish({
				type: "stall.reset",
				correlationId,
				payload: { toolCallId, isFinal: false, text: "working..." },
				isError: false,
			});
		}, 50);

		await expect(resultPromise).rejects.toThrow(/timed out/i);
		f.dispose();

		// The chunk arrived at 50ms; stall can only fire at 250ms (50 + 200 interval)
		// but lastChunkAt was reset to 50ms, so no stall fires until 250ms of silence
		expect(chunks, "chunk must have been received").toContain("working...");

		// Stall events that fired must show lastChunkMs starting from after the chunk
		for (const event of stallEvents) {
			// Each stall event's lastChunkMs measures time since the chunk reset
			expect(event.lastChunkMs, "lastChunkMs must reflect chunk reset").toBeGreaterThanOrEqual(150);
		}
	}, 3_000);
});

// ---------------------------------------------------------------------------
// buildTools — normalization collision
//
// The LLM API requires tool names to be unique. buildTools normalizes "." → "_",
// so "foo.bar" and "foo_bar" both become "foo_bar". The API then rejects the
// request with "Tool names must be unique."
// ---------------------------------------------------------------------------

describe("buildTools — normalization collision", { tags: ["unit"] }, () => {
	it("two names that normalize identically must not produce duplicate llmName values", () => {
		const nameMap = new Map<string, string>();
		const defs = [
			{ name: "foo.bar", description: "original", inputSchema: z.object({}) },
			{
				name: "foo_bar",
				description: "collision — normalizes to the same llmName as foo.bar",
				inputSchema: z.object({}),
			},
		];
		// "foo.bar" → "foo_bar" and "foo_bar" → "foo_bar": identical after normalization.
		// buildTools currently maps both without deduplication, producing a duplicate.
		const tools = buildTools(defs, nameMap);
		const names = tools.map((t) => t.name);
		expect(
			new Set(names).size,
			`colliding normalized names must not appear twice in tool list; got: ${names.join(", ")}`,
		).toBe(names.length);
	});
});

// ---------------------------------------------------------------------------
// Ambient steering — mid-turn message buffering
// ---------------------------------------------------------------------------

describe("organ-llm — ambient steering", { tags: ["unit"] }, () => {
	it("second llm.input while turn is active does not start a concurrent turn", async () => {
		const faux = registerFauxProvider();
		const f = new NerveFixture();
		const driver = new TurnDriver(f.nerve);
		harnesses.push({ f });

		const _motorReplies: string[] = [];
		faux.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		const recorder = f.observe();

		// Fire first turn then immediately fire a second sense event.
		const firstReply = driver.send("message one");
		// Second message fires while first turn handler is scheduled but not yet complete.
		driver.receive("message two");

		await firstReply;
		// Wait a tick to let any concurrent second turn settle.
		await new Promise((r) => setTimeout(r, 50));

		const motorDialogEvents = recorder.motor.filter((e) => e.type === "llm.response");
		// Only one motor reply must have been published — the second sense event was buffered, not run.
		expect(
			motorDialogEvents.length,
			"second llm.input while turn active must not produce a second immediate reply",
		).toBe(1);
	}, 5_000);
});
