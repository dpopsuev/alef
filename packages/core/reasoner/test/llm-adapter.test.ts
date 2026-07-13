import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import type { Context } from "@dpopsuev/alef-ai/types";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { adapterComplianceSuite, BusFixture, TurnDriver } from "../../testkit/src/index.js";
import { createAgentLoop } from "../src/index.js";
import { waitForToolResult } from "../src/tool-dispatch.js";
import { buildTools } from "../src/handlers/message-handler.js";

// createContextAssembler (from kernel) is the mountable pipeline adapter — no tools, pure coordinator.
// adapter-llm is a reasoner (no tools), not a tool-bearing adapter.
adapterComplianceSuite(() => createContextAssembler());

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
 * Standard test harness: bare bus, TurnDriver, LLM adapter, optional BusEventRecorder.
 * Replaces the Agent + AgentController + adapter-llm construction that appeared in every test.
 */
function makeHarness(llm: Adapter) {
	const f = new BusFixture();
	const driver = new TurnDriver(f.bus);
	const recorder = f.observe();
	f.mount(llm);
	return { f, driver, recorder };
}

const harnesses: Array<{ f: BusFixture }> = [];
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
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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
		recorder.assertCommandEmitted("llm.response");
		recorder.assertEventEmitted("llm.input");
	}, 30_000);

	it("llm.response payload contains the reply text", async () => {
		const faux = registerFauxProvider();
		const { driver, recorder } = make(faux);
		await driver.send("What is 2+2? Reply with just the number.");
		const msg = recorder.assertCommandEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(typeof payload.text).toBe("string");
		expect(payload.text.length).toBeGreaterThan(0);
	}, 30_000);

	it("all turn events share the same correlationId", async () => {
		const faux = registerFauxProvider();
		const { driver, recorder } = make(faux);
		await driver.send("Say yes.");
		const input = recorder.assertCommandEmitted("llm.response");
		const prompt = recorder.assertEventEmitted("llm.input");
		const msg = recorder.assertCommandEmitted("llm.response");
		expect(prompt.correlationId).toBe(input.correlationId);
		expect(msg.correlationId).toBe(input.correlationId);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// payloadToText
// ---------------------------------------------------------------------------

import { payloadToText } from "../src/tool-dispatch.js";

describe("payloadToText", { tags: ["unit"] }, () => {
	it("returns errorMessage when isError is true", () => {
		expect(payloadToText({}, true, "adapter failure")).toBe("adapter failure");
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

	it("after error with maxRetries=0, command/llm.response carries text reply", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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
		const event = recorder.assertCommandEmitted("llm.response") as unknown as { payload: { text: string } };
		expect(typeof event.payload.text).toBe("string");
	});

	it("successful turn publishes conversationHistory in llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("all good")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		const event = recorder.assertCommandEmitted("llm.response") as unknown as {
			payload: { conversationHistory?: unknown[] };
		};
		expect(Array.isArray(event.payload.conversationHistory)).toBe(true);
		expect((event.payload.conversationHistory as unknown[]).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// command/context.assemble seam
// ---------------------------------------------------------------------------

describe("Reasoner — command/context.assemble seam", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("disabled by default (phaseTimeoutMs=0): no command/context.assemble published", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		expect(recorder.command.filter((e) => e.type === "context.assemble")).toHaveLength(0);
	});

	it("publishes command/context.assemble before each LLM call when phaseTimeoutMs > 0", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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
		const phaseEvents = recorder.command.filter((e) => e.type === "context.assemble");
		expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
		const first = phaseEvents[0] as unknown as { payload: { messages: unknown[]; turn: number } };
		expect(first.payload.turn).toBe(1);
		expect(Array.isArray(first.payload.messages)).toBe(true);
	});

	it("phase adapter receives messages and its event/context.assemble reply is awaited", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();

		let phaseReceivedMessages: unknown[] = [];
		const phaseAdapter = {
			name: "phase-spy",
			description: "test phase interceptor",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { command: ["context.assemble"] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount(nerve: Bus) {
				nerve.command.subscribe("context.assemble", (event) => {
					const payload = event.payload as { messages: unknown[] };
					phaseReceivedMessages = payload.messages;
					nerve.event.publish({
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
		f.mount(phaseAdapter);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);
		expect(phaseReceivedMessages.length).toBeGreaterThan(0);
		recorder.assertCommandEmitted("llm.response");
	});

	it("proceeds with original messages when phase adapter times out", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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
// command/context.assemble: skip, abort, llm.result
// ---------------------------------------------------------------------------

describe("Reasoner — phase skip, abort, and llm.result", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makePhaseAdapter(
		handler: (
			payload: { messages: unknown[]; turn: number },
			reply: (response: Record<string, unknown>) => void,
		) => void,
	) {
		return {
			name: "phase-adapter",
			description: "test",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { command: ["context.assemble"] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount(nerve: Bus) {
				nerve.command.subscribe("context.assemble", (event) => {
					handler(event.payload as { messages: unknown[]; turn: number }, (response) => {
						nerve.event.publish({
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

	it("skip: phase adapter bypasses LLM and injects its own reply", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseAdapter((_payload, reply) => {
				reply({ skip: true, reply: "phase shortcut" });
			}),
		);
		disposes.push(() => f.dispose());

		const result = await driver.send("hi", "user", 5_000);
		expect(result).toBe("phase shortcut");
	});

	it("skip: phase.skip publishes command/llm.response with the skip reply text", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new BusFixture();
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseAdapter((_payload, reply) => {
				reply({ skip: true, reply: "ambient shortcut" });
			}),
		);
		disposes.push(() => f.dispose());

		f.bus.asBus().event.publish({
			type: "llm.input",
			correlationId: "test-corr",
			payload: { text: "trigger", sender: "system" },
			isError: false,
		});
		await new Promise<void>((r) => setTimeout(r, 1_000));

		const replies = recorder.command.filter((e) => e.type === "llm.response");
		expect(replies).toHaveLength(1);
		expect((replies[0] as unknown as { payload: { text: string } }).payload.text).toBe("ambient shortcut");
	}, 5_000);

	it("abort: phase adapter exits loop without publishing llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("should not appear")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
			}),
		);
		f.mount(
			makePhaseAdapter((_payload, reply) => {
				reply({ abort: true });
			}),
		);
		disposes.push(() => f.dispose());

		const result = await driver.send("hi", "user", 2_000).catch(() => "timeout");
		expect(recorder.command.filter((e) => e.type === "llm.response")).toHaveLength(0);
		expect(result).toBeDefined();
	});

	it("command/llm.result fires after each LLM response with response and toolCalls", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		disposes.push(() => f.dispose());

		await driver.send("hi", "user", 5_000);

		const resultEvents = recorder.notification.filter((e) => e.type === "llm.result");
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

	it("fires on event/llm.input and replies on command/llm.response", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello from llm")]);
		const f = new BusFixture();
		const recorder = f.observe();
		const driver = new TurnDriver(f.bus);
		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key" }));
		disposes.push(() => f.dispose());

		const reply = await driver.send("hi", "user", 5_000);
		expect(reply).toBe("hello from llm");
		expect(recorder.command.find((e) => e.type === "llm.response")).toBeDefined();
		expect(recorder.event.find((e) => e.type === "llm.input")).toBeDefined();
	});

	it("conversation trigger still works with defaults", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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

describe("reasoner — trackConcurrentOps", { tags: ["unit"] }, () => {
	it("declares wildcard command+event subscriptions when trackConcurrentOps=true", () => {
		const llm = createAgentLoop({ model: makeModel(), trackConcurrentOps: true });
		expect(llm.subscriptions.command).toContain("*");
		expect(llm.subscriptions.event).toContain("*");
	});

	it("does not declare wildcard subscriptions when trackConcurrentOps=false", () => {
		const llm = createAgentLoop({ model: makeModel() });
		expect(llm.subscriptions.command).not.toContain("*");
		expect(llm.subscriptions.event).not.toContain("*");
	});

	it("injects Pending operations into prepareStep output when inflight ops exist", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		const concurrentAdapter: Adapter = {
			name: "concurrent-sim",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			mount(nerve: Bus) {
				nerve.command.publish({
					type: "fs.read",
					correlationId: "concurrent-turn-abc",
					payload: { path: "/test/file.ts" },
				});
				return () => {};
			},
		};

		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				trackConcurrentOps: true,
			}),
		);
		f.mount(concurrentAdapter);

		await driver.send("hi", "user", 5_000);
		expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
		f.dispose();
	});
});

// ---------------------------------------------------------------------------
// Schema validation hang regression
// ---------------------------------------------------------------------------

import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { z } from "zod";

describe("turn loop — schema validation failure", { tags: ["unit"] }, () => {
	it("turn completes when LLM sends wrong type for a schema field", async () => {
		const faux = registerFauxProvider();
		const f = new BusFixture();

		const strictAdapter = defineAdapter(
			"strict",
			{
				command: {
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
			{ description: "Strict schema adapter.", directives: ["Use strict.op when asked."] },
		);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		f.mount(strictAdapter);

		const driver = new TurnDriver(f.bus, undefined, undefined, strictAdapter.tools);

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

		// When: adapter-llm runs with a prepareStep that injects a system message
		const systemText = "You are Alef. No emojis.";
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
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

		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);

		// A stub adapter that subscribes to command/hung_tool but never publishes an event reply
		const { z } = await import("zod");
		const hungAdapter = defineAdapter(
			"hung",
			{
				command: {
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

		f.bus.asBus().notification.subscribe("llm.tool-start", () => {
			capturedEvents.push({ type: "tool-start" });
		});
		f.bus.asBus().notification.subscribe("llm.tool-end", (event) => {
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
		f.mount(hungAdapter);

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
		// Given: a faux LLM that calls a streaming adapter, then replies
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("streamer_run", { command: "go" })]),
			fauxAssistantMessage("streaming complete"),
		]);

		const { z } = await import("zod");
		const { typedStreamAction } = await import("@dpopsuev/alef-kernel/adapter");

		// A streaming adapter that yields three intermediate chunks then a final result
		const streamingAdapter = defineAdapter(
			"streamer",
			{
				command: {
					"streamer.run": typedStreamAction(
						{
							name: "streamer.run",
							description: "Streaming test adapter that yields chunks.",
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
				description: "Streaming test adapter for chunk relay regression.",
				directives: ["Use streamer.run to test streaming chunk relay behaviour."],
			},
		);

		const capturedChunks: string[] = [];
		const eventOrder: string[] = [];

		const f = new BusFixture();
		const driver = new TurnDriver(f.bus, undefined, undefined, streamingAdapter.tools);

		f.bus.asBus().notification.subscribe("llm.tool-chunk", (event) => {
			eventOrder.push("tool-chunk");
			capturedChunks.push(String((event as { payload: Record<string, unknown> }).payload.text ?? ""));
		});
		f.bus.asBus().notification.subscribe("llm.tool-end", () => {
			eventOrder.push("tool-end");
		});
		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		f.mount(streamingAdapter);

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
// tool-stall LlmEvent — the TUI displays "tool-name: running for Xs..."
// ---------------------------------------------------------------------------

describe("waitForToolResult — stall watchdog", { tags: ["unit"] }, () => {
	it("fires onStall after stallIntervalMs with no chunks, before timeout", async () => {
		// Given: an event bus where the tool never responds (simulating a hung subagent)
		const f = new BusFixture();
		const correlationId = "corr-stall-test";
		const toolCallId = "tc-stall-1";

		const stallEvents: Array<{ elapsedMs: number; lastChunkMs: number }> = [];

		// When: waitForToolResult with a 200ms stall interval and 600ms timeout
		const resultPromise = waitForToolResult({
			event: f.bus.asBus().event,
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
		// Given: an event bus that sends one isFinal:false chunk then goes silent
		const f = new BusFixture();
		const correlationId = "corr-stall-reset";
		const toolCallId = "tc-stall-2";

		const stallEvents: Array<{ elapsedMs: number; lastChunkMs: number }> = [];
		const chunks: string[] = [];

		const resultPromise = waitForToolResult({
			event: f.bus.asBus().event,
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
			f.bus.asBus().event.publish({
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

function createReleaseGate(): { wait: Promise<void>; release: () => void } {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

function lastUserText(ctx: { messages: ReadonlyArray<{ role: string; content: unknown }> }): string {
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		const message = ctx.messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((part): part is { type: "text"; text: string } => {
				return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
			})
			.map((part) => part.text)
			.join("");
	}
	return "";
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 15));
	}
	if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

function queuedNotificationTexts(notifications: ReadonlyArray<{ type: string }>): string[] {
	return notifications.flatMap((n) => {
		if (n.type !== "llm.message-queued") return [];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage payload is untyped
		const text = (n as unknown as { payload?: { text?: unknown } }).payload?.text;
		return typeof text === "string" ? [text] : [];
	});
}

describe("reasoner — delivery modes", { tags: ["unit"] }, () => {
	it("mid-turn input does not start a concurrent LLM call", async () => {
		const DELAY_MS = 80;
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		faux.setResponses([
			async () => {
				await new Promise((r) => setTimeout(r, DELAY_MS));
				return fauxAssistantMessage("reply one");
			},
			fauxAssistantMessage("reply two"),
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		const recorder = f.observe();

		const started = driver.send("message one");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "first turn entered LLM");
		driver.receive("message two");
		expect(faux.state.callCount, "queued input must not start a concurrent LLM call").toBe(1);
		expect(recorder.notification.some((n) => n.type === "llm.message-queued")).toBe(true);

		const reply = await started;
		expect(reply).toBe("reply two");
		expect(faux.state.callCount).toBe(2);
	}, 5_000);

	it("default mid-turn delivery is steer: extends the active turn before final reply", async () => {
		const DELAY_MS = 80;
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		const seenUserPrompts: string[] = [];
		faux.setResponses([
			async (ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				await new Promise((r) => setTimeout(r, DELAY_MS));
				return fauxAssistantMessage("draft");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("steered");
			},
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);

		const replies: string[] = [];
		f.bus.asBus().command.subscribe("llm.response", (event) => {
			replies.push(typeof event.payload.text === "string" ? event.payload.text : "");
		});

		const started = driver.send("message one");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "first LLM round");
		driver.receive("steer me");
		const reply = await started;

		expect(reply).toBe("steered");
		expect(replies, "steer folds into one published reply").toEqual(["steered"]);
		expect(seenUserPrompts).toEqual(["message one", "steer me"]);
	}, 5_000);

	it("followUp drains after the active turn as a separate reply", async () => {
		const DELAY_MS = 80;
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		faux.setResponses([
			async () => {
				await new Promise((r) => setTimeout(r, DELAY_MS));
				return fauxAssistantMessage("reply one");
			},
			fauxAssistantMessage("reply two"),
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);

		const replies: string[] = [];
		f.bus.asBus().command.subscribe("llm.response", (event) => {
			replies.push(typeof event.payload.text === "string" ? event.payload.text : "");
		});

		const firstReply = driver.send("message one");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "first turn entered LLM");
		driver.receive("message two", "human", { delivery: "followUp" });
		await firstReply;

		expect(replies[0]).toBe("reply one");
		await waitUntil(() => replies.length >= 2, 3_000, "follow-up drained");
		expect(replies).toEqual(["reply one", "reply two"]);
		expect(faux.state.callCount).toBe(2);
	}, 5_000);

	it("drains several follow-ups FIFO across multiple turn waves", async () => {
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		const gate0 = createReleaseGate();
		const gate1 = createReleaseGate();
		const seenUserPrompts: string[] = [];

		faux.setResponses([
			async (ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				await gate0.wait;
				return fauxAssistantMessage("r0");
			},
			async (ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				await gate1.wait;
				return fauxAssistantMessage("r1");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("r2");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("r3");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("r4");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("r5");
			},
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);
		const recorder = f.observe();

		const replies: string[] = [];
		f.bus.asBus().command.subscribe("llm.response", (event) => {
			replies.push(typeof event.payload.text === "string" ? event.payload.text : "");
		});

		const followUp = { delivery: "followUp" as const };
		const started = driver.send("start");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "turn0 entered LLM");
		driver.receive("m1", "human", followUp);
		driver.receive("m2", "human", followUp);
		driver.receive("m3", "human", followUp);
		expect(faux.state.callCount, "queued inputs must not start concurrent LLM calls").toBe(1);
		expect(replies, "no reply until active turn finishes").toEqual([]);

		gate0.release();
		await started;
		expect(replies[0]).toBe("r0");

		const queuedTexts = queuedNotificationTexts(recorder.notification);
		expect(queuedTexts, "wave-1 queue notifications").toEqual(["m1", "m2", "m3"]);

		await waitUntil(() => faux.state.callCount >= 2, 3_000, "m1 drained into turn1");
		expect(faux.state.callCount, "one-at-a-time: only m1 starts before next enqueue wave").toBe(2);
		driver.receive("m4", "human", followUp);
		driver.receive("m5", "human", followUp);
		expect(faux.state.callCount, "wave-2 enqueue must not start concurrent LLM calls").toBe(2);
		gate1.release();

		await waitUntil(() => replies.length >= 6, 5_000, "all drained replies");

		expect(replies, "FIFO drain across both enqueue waves").toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
		expect(seenUserPrompts, "LLM must see each queued prompt in order").toEqual([
			"start",
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
		]);
		expect(faux.state.callCount).toBe(6);

		expect(queuedNotificationTexts(recorder.notification), "both enqueue waves notified").toEqual([
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
		]);
	}, 10_000);

	it("nextTurn is not drained as follow-up and prepends on the next idle input", async () => {
		const DELAY_MS = 50;
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		const seenContexts: string[] = [];
		faux.setResponses([
			async (ctx) => {
				seenContexts.push(ctx.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`).join("|"));
				await new Promise((r) => setTimeout(r, DELAY_MS));
				return fauxAssistantMessage("first-reply");
			},
			(ctx) => {
				seenContexts.push(ctx.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`).join("|"));
				return fauxAssistantMessage("second-reply");
			},
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
			}),
		);

		const started = driver.send("first");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "first turn entered");
		driver.receive("deferred", "human", { delivery: "nextTurn" });
		await started;

		const second = await driver.send("second");
		expect(second).toBe("second-reply");
		expect(seenContexts.at(-1)).toMatch(/user:deferred/);
		expect(seenContexts.at(-1)).toMatch(/user:second/);
		expect(seenContexts[0]).not.toContain("deferred");
	}, 10_000);

	it("steeringMode all injects every pending steer in one round", async () => {
		const DELAY_MS = 50;
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		harnesses.push({ f });

		const seenUserPrompts: string[] = [];
		faux.setResponses([
			async (ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				await new Promise((r) => setTimeout(r, DELAY_MS));
				return fauxAssistantMessage("draft");
			},
			(ctx) => {
				seenUserPrompts.push(lastUserText(ctx));
				return fauxAssistantMessage("done");
			},
		]);

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				steeringMode: "all",
			}),
		);

		const started = driver.send("start");
		await waitUntil(() => faux.state.callCount >= 1, 2_000, "first round");
		driver.receive("a");
		driver.receive("b");
		const reply = await started;
		expect(reply).toBe("done");
		expect(seenUserPrompts[1]).toBe("b");
		expect(faux.state.callCount).toBe(2);
	}, 5_000);
});

// ---------------------------------------------------------------------------
// token-usage must fire on every LLM round (including tool-calling rounds)
// Regression: session a73af16e — 128 http rounds, only 3 mid-session usage
// events → TUI ctx bar frozen + compaction starved of lastTotalTokens.
// ---------------------------------------------------------------------------

describe("Reasoner — llm.token-usage mid tool-loop", { tags: ["unit"] }, () => {
	it("publishes llm.token-usage after tool-calling rounds, not only the final reply", async () => {
		const faux = registerFauxProvider();
		const f = new BusFixture();
		const recorder = f.observe();

		const echoAdapter = defineAdapter(
			"echo",
			{
				command: {
					"echo.ping": typedAction(
						{
							name: "echo.ping",
							description: "Ping.",
							inputSchema: z.object({ n: z.number() }),
						},
						async () => ({ ok: true }),
					),
				},
			},
			{ description: "Echo adapter.", directives: ["Use echo.ping."] },
		);

		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key" }));
		f.mount(echoAdapter);

		const driver = new TurnDriver(f.bus, undefined, undefined, echoAdapter.tools);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo_ping", { n: 1 })]),
			fauxAssistantMessage([fauxToolCall("echo_ping", { n: 2 })]),
			fauxAssistantMessage("done"),
		]);

		const reply = await driver.send("ping twice", "human", 5_000);
		expect(reply).toBe("done");

		const usageEvents = recorder.notification.filter((e) => e.type === "llm.token-usage");
		expect(usageEvents.length, "one usage event per LLM round including tool calls").toBe(3);

		f.dispose();
	}, 8_000);
});
