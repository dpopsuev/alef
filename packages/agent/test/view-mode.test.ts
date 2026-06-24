/**
 * HeadlessViewMode — the test-facing viewer that records every AgentEvent.
 *
 * Structure:
 *   Unit:        MockSession → fire events manually → assert captures
 *   Integration: Faux LLM + real Agent → send messages → assert event stream
 *   Tool-call:   Stub adapter + faux LLM → assert tool lifecycle ordering
 */

import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel/adapter";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentEvent, Session } from "../src/session.js";
import { HeadlessViewMode } from "../src/view-mode.js";

// ---------------------------------------------------------------------------
// MockSession — typed so _emit is accessible without casting
// ---------------------------------------------------------------------------

interface MockSession extends Session {
	_emit(event: AgentEvent): void;
}

function mockSession(overrides: Partial<Session> = {}): MockSession {
	const observers = new Set<(event: AgentEvent) => void>();
	return {
		state: { id: "mock", modelId: "mock-model", contextWindow: 4096 },
		getModel: () => "mock-model",
		setModel: () => {},
		getThinking: () => "off",
		setThinking: () => {},
		setTurnController: () => {},
		dispose: () => {},
		subscribe: (obs: (event: AgentEvent) => void) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
		_emit: (event: AgentEvent) => {
			for (const obs of observers) obs(event);
		},
		...overrides,
	} as MockSession;
}

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

const CHUNK_A: AgentEvent = { type: "chunk", text: "hello " };
const CHUNK_B: AgentEvent = { type: "chunk", text: "world" };
const TURN_COMPLETE: AgentEvent = { type: "turn-complete", reply: "hello world" };
const TOOL_START: AgentEvent = { type: "tool-start", callId: "c1", name: "fs.read", args: { path: "README.md" } };
const TOOL_END: AgentEvent = { type: "tool-end", callId: "c1", elapsedMs: 42, ok: true };
const CHUNK_RESULT: AgentEvent = { type: "chunk", text: "result" };
const TURN_ERROR: AgentEvent = { type: "turn-error", message: "LLM timeout" };

// ---------------------------------------------------------------------------
// Agent session factory — adapts real Agent + faux LLM to Session interface
// ---------------------------------------------------------------------------

/** Maps raw command bus events to AgentEvent. Returns null for events we don't surface. */
function commandEventToAgentEvent(e: { type: string; payload: Record<string, unknown> }): AgentEvent | null {
	if (e.type === "llm.chunk" && typeof e.payload.text === "string") {
		return { type: "chunk", text: e.payload.text };
	}
	if (e.type === "llm.response" && typeof e.payload.text === "string") {
		return { type: "turn-complete", reply: e.payload.text };
	}
	if (e.type === "llm.tool-start") {
		return {
			type: "tool-start",
			callId: String(e.payload.callId ?? ""),
			name: String(e.payload.name ?? ""),
			args: (e.payload.args as Record<string, unknown>) ?? {},
		};
	}
	if (e.type === "llm.tool-end") {
		return {
			type: "tool-end",
			callId: String(e.payload.callId ?? ""),
			elapsedMs: Number(e.payload.elapsedMs ?? 0),
			ok: Boolean(e.payload.ok),
		};
	}
	return null;
}

interface AgentSession {
	faux: ReturnType<typeof registerFauxProvider>;
	session: Session;
	dispose(): void;
}

function makeAgentSession(extraAdapters: import("@dpopsuev/alef-kernel").Adapter[] = []): AgentSession {
	const faux = registerFauxProvider();
	const agent = new Agent();
	let lastReply = "";
	const observers = new Set<(event: AgentEvent) => void>();

	const controller = new AgentController(agent, {
		onReply: (text: string) => {
			if (text) lastReply = text;
		},
	});
	const llm = createAgentLoop({ model: faux.getModel(), apiKey: "faux" });

	for (const adapter of extraAdapters) agent.load(adapter);
	agent.load(llm);

	agent.observe({
		onCommand(event) {
			// llm.response stays on command; all other llm.* telemetry is on notification.
			const agentEvent = commandEventToAgentEvent(
				event as unknown as { type: string; payload: Record<string, unknown> },
			);
			if (agentEvent) for (const obs of observers) obs(agentEvent);
		},
		onEvent() {},
		onNotification(event) {
			const agentEvent = commandEventToAgentEvent(
				event as unknown as { type: string; payload: Record<string, unknown> },
			);
			if (agentEvent) for (const obs of observers) obs(agentEvent);
		},
	});

	const session: Session = {
		state: { id: "test", modelId: faux.getModel().id, contextWindow: 128_000 },
		getModel: () => faux.getModel().id,
		setModel: () => {},
		getThinking: () => "off",
		setThinking: () => {},
		setTurnController: () => {},
		dispose: () => agent.dispose(),
		send: async (text, timeoutMs = 10_000) => {
			await agent.ready();
			await controller.send(text, "human", timeoutMs);
			return lastReply;
		},
		subscribe: (obs) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
	};

	return {
		faux,
		session,
		dispose: () => {
			agent.dispose();
			faux.unregister();
		},
	};
}

// ---------------------------------------------------------------------------
// Echo stub adapter — used by tool-call tests
// ---------------------------------------------------------------------------

const ECHO_ADAPTER = defineAdapter(
	"echo-stub",
	{
		command: {
			echo: typedAction(
				{ name: "echo", description: "Echo the input back", inputSchema: z.object({ message: z.string() }) },
				async (ctx) =>
					withDisplay(
						{ result: ctx.payload.message },
						{ text: String(ctx.payload.message), mimeType: "text/plain" },
					),
			),
		},
	},
	{
		description: "Test stub: echoes its input back as the tool result.",
		directives: ["Use echo to return the exact message string passed to it."],
	},
);

// ---------------------------------------------------------------------------
// Unit tests — MockSession, no network
// ---------------------------------------------------------------------------

describe("HeadlessViewMode — unit", { tags: ["unit"] }, () => {
	it("records chunks and the final reply", async () => {
		const session = mockSession();
		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);

		session._emit(CHUNK_A);
		session._emit(CHUNK_B);
		session._emit(TURN_COMPLETE);
		viewer.complete();
		await running;

		expect(viewer.chunks()).toEqual(["hello ", "world"]);
		expect(viewer.replies()).toEqual(["hello world"]);
		expect(viewer.lastReply()).toBe("hello world");
	});

	it("eventsOfType filters to the correct discriminant", async () => {
		const session = mockSession();
		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);

		session._emit(TOOL_START);
		session._emit(TOOL_END);
		session._emit(CHUNK_RESULT);
		viewer.complete();
		await running;

		expect(viewer.toolStarts()).toHaveLength(1);
		expect(viewer.toolStarts()[0].name).toBe("fs.read");
		expect(viewer.toolEnds()[0].ok).toBe(true);
		expect(viewer.chunks()).toEqual(["result"]);
		expect(viewer.errors()).toHaveLength(0);
	});

	it("captures turn-error messages", async () => {
		const session = mockSession();
		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);

		session._emit(TURN_ERROR);
		viewer.complete();
		await running;

		expect(viewer.errors()).toEqual(["LLM timeout"]);
		expect(viewer.replies()).toHaveLength(0);
	});

	it("run() does not resolve until complete() is called", async () => {
		const session = mockSession();
		const viewer = new HeadlessViewMode();
		let resolved = false;

		const running = viewer.run(session).then(() => {
			resolved = true;
		});

		await Promise.resolve();
		expect(resolved).toBe(false);

		viewer.complete();
		await running;
		expect(resolved).toBe(true);
	});

	it("complete() is idempotent", async () => {
		const session = mockSession();
		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);

		viewer.complete();
		viewer.complete(); // must not throw
		await running;
	});

	it("unsubscribes from the session when complete() is called", async () => {
		let subscriptionActive = true;
		const session = mockSession({
			subscribe: (_obs) => () => {
				subscriptionActive = false;
			},
		});
		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);

		viewer.complete();
		await running;

		expect(subscriptionActive).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration tests — faux LLM + real Agent
// ---------------------------------------------------------------------------

describe("HeadlessViewMode — faux LLM integration", { tags: ["unit"] }, () => {
	const disposals: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposals.splice(0)) dispose();
	});

	it("captures a simple text reply", async () => {
		const { faux, session, dispose } = makeAgentSession();
		disposals.push(dispose);
		faux.setResponses([fauxAssistantMessage("hello from the agent")]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("hi");
		viewer.complete();
		await running;

		expect(viewer.lastReply()).toBe("hello from the agent");
		expect(viewer.replies()).toHaveLength(1);
	});

	it("chunks arrive and join to form the reply text", async () => {
		const { faux, session, dispose } = makeAgentSession();
		disposals.push(dispose);
		faux.setResponses([fauxAssistantMessage("streamed response")]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("stream");
		viewer.complete();
		await running;

		expect(viewer.chunks().join("")).toContain("streamed response");
	});

	it("accumulates replies across sequential turns", async () => {
		const { faux, session, dispose } = makeAgentSession();
		disposals.push(dispose);
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("turn one");
		await viewer.send("turn two");
		viewer.complete();
		await running;

		expect(viewer.replies()).toEqual(["first", "second"]);
	});

	it("event list grows across sends and includes chunks", async () => {
		const { faux, session, dispose } = makeAgentSession();
		disposals.push(dispose);
		faux.setResponses([fauxAssistantMessage("alpha"), fauxAssistantMessage("beta"), fauxAssistantMessage("gamma")]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("one");
		await viewer.send("two");
		await viewer.send("three");
		viewer.complete();
		await running;

		expect(viewer.replies()).toEqual(["alpha", "beta", "gamma"]);
		expect(viewer.events.length).toBeGreaterThan(3);
	});

	it("every chunk event index is lower than the turn-complete index", async () => {
		const { faux, session, dispose } = makeAgentSession();
		disposals.push(dispose);
		faux.setResponses([fauxAssistantMessage("streamed text")]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("go");
		viewer.complete();
		await running;

		const chunkIndices = viewer.events.map((e, i) => (e.type === "chunk" ? i : -1)).filter((i) => i !== -1);
		const completeIndex = viewer.events.findIndex((e) => e.type === "turn-complete");

		expect(chunkIndices.length).toBeGreaterThan(0);
		expect(Math.max(...chunkIndices)).toBeLessThan(completeIndex);
	});
});

// ---------------------------------------------------------------------------
// Tool-call integration — stub adapter + faux LLM
// ---------------------------------------------------------------------------

describe("HeadlessViewMode — tool-call lifecycle", { tags: ["unit"] }, () => {
	const disposals: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposals.splice(0)) dispose();
	});

	it("captures tool-start → tool-end → turn-complete in order", async () => {
		const { faux, session, dispose } = makeAgentSession([ECHO_ADAPTER]);
		disposals.push(dispose);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { message: "hello" })]),
			fauxAssistantMessage("the echo said: hello"),
		]);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("call echo");
		viewer.complete();
		await running;

		expect(viewer.toolStarts()).toHaveLength(1);
		expect(viewer.toolStarts()[0].name).toBe("echo");
		expect(viewer.toolStarts()[0].args).toMatchObject({ message: "hello" });

		expect(viewer.toolEnds()).toHaveLength(1);
		expect(viewer.toolEnds()[0].ok).toBe(true);

		expect(viewer.lastReply()).toBe("the echo said: hello");

		const startIdx = viewer.events.findIndex((e) => e.type === "tool-start");
		const endIdx = viewer.events.findIndex((e) => e.type === "tool-end");
		const completeIdx = viewer.events.findIndex((e) => e.type === "turn-complete");

		expect(startIdx).toBeLessThan(endIdx);
		expect(endIdx).toBeLessThan(completeIdx);
	}, 15_000);
});
