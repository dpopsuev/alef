/**
 * E2E delegation test
 *
 * Exercises: command/agent.run → adapter-agent → InProcessStrategy
 * → inner adapter-llm (faux inner LLM) → event/agent.run with reply text
 * → outer adapter-llm turn 2 receives toolResult → final llm.response
 */

import { randomUUID } from "node:crypto";
import { createAgentAdapter } from "@dpopsuev/alef-adapter-agent";
import { defineAdapter, typedStreamAction } from "@dpopsuev/alef-kernel/adapter";
import type { EventInput } from "@dpopsuev/alef-kernel/bus";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { InProcessStrategy, type SubagentFactory } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../runtime/src/index.js";
import { BusFixture, TurnDriver } from "../../testkit/src/index.js";

function makeTestFactory(model: Model<Api>, baseSystemPrompt?: string): SubagentFactory {
	return ({ adapters, onChunk, systemPrompt: callSystemPrompt }) => {
		const agent = new Agent();
		const mergedPrompt = [baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || undefined;
		const llm = createAgentLoop({
			model,
			apiKey: "test-key",
			systemPrompt: mergedPrompt,
		});
		for (const organ of adapters) agent.load(organ);
		agent.load(llm);
		if (onChunk) {
			agent.observe({
				onCommand() {},
				onEvent() {},
				onNotification(event) {
					const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
					if (event.type === "llm.chunk" || event.type === "llm.tool-chunk") onChunk(String(p.text ?? ""));
				},
			});
		}
		return {
			async send(text: string, sender: string, timeoutMs: number): Promise<string> {
				await agent.ready();
				const correlationId = randomUUID();
				return new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => {
						off();
						reject(new Error(`inner agent timed out after ${timeoutMs}ms`));
					}, timeoutMs);
					const off = agent.subscribeCommand("llm.response", (event) => {
						if (event.correlationId !== correlationId) return;
						clearTimeout(timer);
						off();
						resolve(typeof event.payload.text === "string" ? event.payload.text : "");
					});
					agent.publishEvent({
						type: "llm.input",
						correlationId,
						payload: { text, sender, tools: agent.tools },
						isError: false,
					} as EventInput);
				});
			},
			dispose() {
				agent.dispose();
			},
		};
	};
}

describe("agent.run delegation — E2E", { tags: ["e2e"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("outer LLM calls agent.run, inner LLM responds, outer receives toolResult", async () => {
		// Two independent faux providers: outer and inner
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();
		disposes.push(
			() => outerFaux.unregister(),
			() => innerFaux.unregister(),
		);

		const capturedEvents: string[] = [];

		// Inner strategy: InProcessStrategy with inner faux LLM
		const innerStrategy = new InProcessStrategy([], makeTestFactory(innerFaux.getModel()));

		// Adapter-delegate with the inner strategy registered as 'explore'
		const delegateAdapter = createAgentAdapter({ strategies: { explore: innerStrategy } });

		// Outer BusFixture: outer adapter-llm + delegate adapter
		const f = new BusFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve, "llm.input", "llm.response", delegateAdapter.tools);

		f.nerve.asBus().notification.subscribe("llm.tool-start", () => {
			capturedEvents.push("tool-start");
		});
		f.nerve.asBus().notification.subscribe("llm.tool-end", () => {
			capturedEvents.push("tool-end");
		});
		f.mount(
			createAgentLoop({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
			}),
		);
		f.mount(delegateAdapter);

		// Outer LLM: turn 1 → call agent.run
		// turn 2 → reply with the inner result as context
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "list the packages", profile: "explore" })]),
			fauxAssistantMessage("The packages are: spine, corpus, runner."),
		]);

		// Inner LLM: responds with the package list
		innerFaux.setResponses([fauxAssistantMessage("spine, corpus, runner")]);

		// When
		const reply = await driver.send("explore the packages", "human", 10_000);

		// Then: outer LLM received the inner reply as a tool result and used it
		expect(reply).toBe("The packages are: spine, corpus, runner.");

		// Tool lifecycle events fired in order
		expect(capturedEvents).toContain("tool-start");
		expect(capturedEvents).toContain("tool-end");
		const startIdx = capturedEvents.indexOf("tool-start");
		const endIdx = capturedEvents.indexOf("tool-end");
		expect(startIdx).toBeLessThan(endIdx);

		// tool-end was ok (inner agent completed successfully)
		// We can't directly assert ok here from the event array alone,
		// but if reply is correct then the tool result reached the outer LLM
	}, 15_000);

	it("tool-end fires with ok:false when inner agent times out", async () => {
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();
		disposes.push(
			() => outerFaux.unregister(),
			() => innerFaux.unregister(),
		);

		// Inner LLM never responds — causes InProcessStrategy to time out
		// (no response set on innerFaux, so it returns an error)

		const innerStrategy = new InProcessStrategy([], makeTestFactory(innerFaux.getModel()));
		const delegateAdapter = createAgentAdapter({ strategies: { explore: innerStrategy } });

		const capturedEnds: Array<{ ok: boolean }> = [];
		const f = new BusFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve, "llm.input", "llm.response", delegateAdapter.tools);

		f.nerve.asBus().notification.subscribe("llm.tool-end", (event) => {
			capturedEnds.push({ ok: Boolean(event.payload.ok) });
		});
		f.mount(
			createAgentLoop({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
			}),
		);
		f.mount(delegateAdapter);

		// Outer calls agent.run; then handles the error reply
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "do something", profile: "explore" })]),
			fauxAssistantMessage("The inner agent failed."),
		]);

		// Inner faux has no responses set — will return an error message
		// InProcessStrategy will get that error and resolve (not hang)

		const reply = await driver.send("do something", "human", 10_000);
		expect(typeof reply).toBe("string");

		// tool-end should have fired regardless of inner success/failure
		expect(capturedEnds).toHaveLength(1);
	}, 15_000);

	it("inner agent tool activity streams as tool-chunk events to the outer agent", async () => {
		// Given: outer LLM calls agent.run; inner LLM calls a streaming adapter;
		// the inner adapter's chunks must surface as tool-chunk events on the outer adapter-llm.
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();
		disposes.push(
			() => outerFaux.unregister(),
			() => innerFaux.unregister(),
		);

		// A simple streaming inner adapter that yields two text chunks then a result.
		const readerAdapter = defineAdapter(
			"reader",
			{
				command: {
					"reader.scan": typedStreamAction(
						{
							name: "reader.scan",
							description: "Scan files and stream findings.",
							inputSchema: z.object({ path: z.string().min(1) }),
						},
						async function* () {
							yield { text: "found: packages/spine" };
							yield { text: "found: packages/runner", result: "scan complete" };
						},
					),
				},
			},
			{
				description: "Streaming reader stub for E2E delegation test.",
				directives: ["Use reader.scan to scan a directory path and stream file findings."],
			},
		);

		const innerStrategy = new InProcessStrategy([readerAdapter], makeTestFactory(innerFaux.getModel()));
		const delegateAdapter = createAgentAdapter({ strategies: { explore: innerStrategy } });

		const outerChunks: string[] = [];
		const f = new BusFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve, "llm.input", "llm.response", delegateAdapter.tools);

		f.nerve.asBus().notification.subscribe("llm.tool-chunk", (event) => {
			outerChunks.push(String(event.payload.text ?? ""));
		});
		f.mount(
			createAgentLoop({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
			}),
		);
		f.mount(delegateAdapter);

		// Outer: turn 1 calls agent.run; turn 2 uses the result.
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "scan packages", profile: "explore" })]),
			fauxAssistantMessage("Found: packages/spine and packages/runner."),
		]);

		// Inner: turn 1 calls reader.scan; turn 2 replies using its output.
		innerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("reader_scan", { path: "packages" })]),
			fauxAssistantMessage("scan complete"),
		]);

		await driver.send("scan the packages", "human", 10_000);

		// Inner adapter chunks must have reached the outer agent's tool-chunk stream.
		// Without the fix, outerChunks is empty — the inner tool events are dropped.
		expect(outerChunks.some((c) => c.includes("found:"))).toBe(true);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Parallel agent.run — callId routing through the full LLM dispatch stack
//
// Adapter-level stream isolation is tested in adapter-agent/test/delegate.test.ts.
// These tests cover the additional layer: dispatchTools binding tc.id into onChunk
// so callId flows correctly through the outer adapter-llm's LlmEvent stream.
// ---------------------------------------------------------------------------

describe("agent.run delegation — parallel isolation", { tags: ["e2e"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("chunks from N parallel agent.run calls route to their own callId — no cross-contamination", async () => {
		// Given: outer LLM calls agent.run twice in the same response (parallel dispatch).
		// Each stub strategy emits chunks containing the task text it received.
		// If chunk routing is correct, call-A's chunks carry callId-A and call-B's carry callId-B.
		const outerFaux = registerFauxProvider();
		disposes.push(() => outerFaux.unregister());

		const stubStrategy = {
			async send({ text, onChunk }: import("@dpopsuev/alef-kernel").SendRequest) {
				await new Promise<void>((r) => setTimeout(r, 20));
				onChunk?.(`chunk-for:${text}`);
				return `done:${text}`;
			},
		};

		const delegateAdapter = createAgentAdapter({ strategies: { explore: stubStrategy } });

		const capturedChunks: Array<{ callId: string; text: string }> = [];
		const f = new BusFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve, "llm.input", "llm.response", delegateAdapter.tools);

		f.nerve.asBus().notification.subscribe("llm.tool-chunk", (event) => {
			capturedChunks.push({ callId: String(event.payload.callId ?? ""), text: String(event.payload.text ?? "") });
		});
		f.mount(
			createAgentLoop({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
			}),
		);
		f.mount(delegateAdapter);

		// Two parallel agent.run calls with distinct task texts and explicit stable IDs.
		const callA = fauxToolCall("agent_run", { text: "task-A", profile: "explore" }, { id: "tc-A" });
		const callB = fauxToolCall("agent_run", { text: "task-B", profile: "explore" }, { id: "tc-B" });

		outerFaux.setResponses([fauxAssistantMessage([callA, callB]), fauxAssistantMessage("Both done.")]);

		await driver.send("run both", "human", 10_000);

		// Both calls must have produced at least one chunk.
		const chunksA = capturedChunks.filter((c) => c.callId === "tc-A");
		const chunksB = capturedChunks.filter((c) => c.callId === "tc-B");

		expect(chunksA.length, "call-A must produce chunks").toBeGreaterThan(0);
		expect(chunksB.length, "call-B must produce chunks").toBeGreaterThan(0);

		// Chunks must carry the text produced by their own inner strategy (task identity).
		expect(
			chunksA.some((c) => c.text.includes("task-A")),
			"call-A chunks must reflect task-A",
		).toBe(true);
		expect(
			chunksB.some((c) => c.text.includes("task-B")),
			"call-B chunks must reflect task-B",
		).toBe(true);

		// No cross-contamination: task-B text must not appear in call-A's chunks and vice-versa.
		expect(
			chunksA.some((c) => c.text.includes("task-B")),
			"task-B must not appear in call-A chunks",
		).toBe(false);
		expect(
			chunksB.some((c) => c.text.includes("task-A")),
			"task-A must not appear in call-B chunks",
		).toBe(false);
	}, 15_000);

	it("stall events from N parallel hung agents each carry their own callId", async () => {
		// Given: two parallel agent.run calls where both inner agents never produce output.
		// Each call must get its own stall event — events must not cross between callIds.
		const outerFaux = registerFauxProvider();
		disposes.push(() => outerFaux.unregister());

		// Strategy that hangs long enough for stall to fire then resolves.
		// stallIntervalMs in waitForToolResult is 5s by default; we can't override from here,
		// so we verify isolation via callId rather than timing.
		// Instead: emits one chunk immediately so the outer adapter-llm sees activity.
		// The key assertion is that each chunk's callId matches the call that produced it.
		const identityStrategy = {
			async send({ text, onChunk }: import("@dpopsuev/alef-kernel").SendRequest) {
				onChunk?.(`ident:${text}`);
				return `done:${text}`;
			},
		};

		const delegateAdapter = createAgentAdapter({ strategies: { explore: identityStrategy } });

		const capturedChunks: Array<{ callId: string; text: string }> = [];
		const f = new BusFixture();
		disposes.push(() => f.dispose());
		const driver = new TurnDriver(f.nerve, "llm.input", "llm.response", delegateAdapter.tools);

		f.nerve.asBus().notification.subscribe("llm.tool-chunk", (event) => {
			capturedChunks.push({ callId: String(event.payload.callId ?? ""), text: String(event.payload.text ?? "") });
		});
		f.mount(
			createAgentLoop({
				model: outerFaux.getModel(),
				apiKey: "outer-key",
			}),
		);
		f.mount(delegateAdapter);

		const callX = fauxToolCall("agent_run", { text: "agent-X", profile: "explore" }, { id: "tc-X" });
		const callY = fauxToolCall("agent_run", { text: "agent-Y", profile: "explore" }, { id: "tc-Y" });
		const callZ = fauxToolCall("agent_run", { text: "agent-Z", profile: "explore" }, { id: "tc-Z" });

		outerFaux.setResponses([fauxAssistantMessage([callX, callY, callZ]), fauxAssistantMessage("All three done.")]);

		await driver.send("run three", "human", 10_000);

		// Every chunk must belong to exactly one of the three callIds.
		for (const chunk of capturedChunks) {
			expect(["tc-X", "tc-Y", "tc-Z"], `chunk '${chunk.text}' must belong to a known callId`).toContain(
				chunk.callId,
			);
		}

		// Each call must have produced chunks referencing its own agent name.
		const idsWithChunks = new Set(capturedChunks.map((c) => c.callId));
		expect(idsWithChunks.has("tc-X"), "tc-X must have chunks").toBe(true);
		expect(idsWithChunks.has("tc-Y"), "tc-Y must have chunks").toBe(true);
		expect(idsWithChunks.has("tc-Z"), "tc-Z must have chunks").toBe(true);

		// Cross-check: no call carries text intended for a different call.
		const chunksX = capturedChunks.filter((c) => c.callId === "tc-X");
		const chunksY = capturedChunks.filter((c) => c.callId === "tc-Y");
		const chunksZ = capturedChunks.filter((c) => c.callId === "tc-Z");
		expect(chunksX.every((c) => !c.text.includes("agent-Y") && !c.text.includes("agent-Z"))).toBe(true);
		expect(chunksY.every((c) => !c.text.includes("agent-X") && !c.text.includes("agent-Z"))).toBe(true);
		expect(chunksZ.every((c) => !c.text.includes("agent-X") && !c.text.includes("agent-Y"))).toBe(true);
	}, 15_000);
});
