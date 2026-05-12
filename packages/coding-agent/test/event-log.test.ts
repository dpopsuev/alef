/**
 * Tests for the typed EventLog — discriminated unions, idempotency,
 * dead letter queue, direction filtering, cursors.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EventInput } from "../src/board/event-log.js";
import { byDirection, byKind, bySource, byTrace, Cursor, MemLog } from "../src/board/event-log.js";

function userInput(
	text: string,
	opts: { id?: string; version?: number; traceId?: string; parentId?: string; timestamp?: number } = {},
): EventInput {
	return { kind: "user.input", data: { text }, source: "user", direction: "inbound", ...opts };
}

function assistantOutput(text: string, model = "test-model"): EventInput {
	return { kind: "assistant.output", data: { text, model }, source: "assistant", direction: "outbound" };
}

function agentSpawned(agentId: string, color: string): EventInput {
	return {
		kind: "agent.spawned",
		data: { agentId, color, role: "worker", schema: "worker" },
		source: "supervisor",
		direction: "outbound",
	};
}

function toolCalled(toolName: string): EventInput {
	return {
		kind: "tool.called",
		data: { toolCallId: "tc1", toolName, args: {} },
		source: "assistant",
		direction: "outbound",
	};
}

function memoryConflict(): EventInput {
	return {
		kind: "memory.conflict",
		data: { entityId: "e1", oldValue: "sessions", newValue: "JWT", resolution: "updated" },
		source: "librarian",
		direction: "outbound",
	};
}

// ===========================================================================
// Core: emit and read
// ===========================================================================

describe("MemLog — emit and read", () => {
	let log: MemLog;
	beforeEach(() => {
		log = new MemLog();
	});

	it("emit returns sequential index", () => {
		expect(log.emit(userInput("a"))).toBe(0);
		expect(log.emit(userInput("b"))).toBe(1);
		expect(log.len()).toBe(2);
	});

	it("events have id, timestamp, index, version", () => {
		log.emit(userInput("hello"));
		const [event] = log.since(0);
		expect(event.id).toBeTruthy();
		expect(event.timestamp).toBeGreaterThan(0);
		expect(event.index).toBe(0);
		expect(event.version).toBe(1);
	});

	it("since reads from index onward", () => {
		log.emit(userInput("a"));
		log.emit(userInput("b"));
		log.emit(userInput("c"));
		expect(log.since(0)).toHaveLength(3);
		expect(log.since(1)).toHaveLength(2);
		expect(log.since(3)).toHaveLength(0);
	});

	it("since with negative index returns all", () => {
		log.emit(userInput("a"));
		expect(log.since(-1)).toHaveLength(1);
	});

	it("events are typed — kind and data match", () => {
		log.emit(userInput("hello"));
		log.emit(assistantOutput("world"));
		const events = log.since(0);
		expect(events[0].kind).toBe("user.input");
		expect(events[1].kind).toBe("assistant.output");
	});
});

// ===========================================================================
// Idempotency
// ===========================================================================

describe("MemLog — idempotency", () => {
	it("duplicate ID is silently skipped", () => {
		const log = new MemLog();
		const id = "dedup-1";
		log.emit(userInput("first", { id }));
		log.emit(userInput("second", { id })); // same ID — skip

		expect(log.len()).toBe(1);
		const [event] = log.since(0);
		expect((event.data as { text: string }).text).toBe("first"); // first wins
	});

	it("different IDs are both accepted", () => {
		const log = new MemLog();
		log.emit(userInput("a", { id: "id-1" }));
		log.emit(userInput("b", { id: "id-2" }));
		expect(log.len()).toBe(2);
	});
});

// ===========================================================================
// Dead letter queue
// ===========================================================================

describe("MemLog — dead letter queue", () => {
	it("captures failed hooks without breaking emit", () => {
		const log = new MemLog();
		log.onEmit(() => {
			throw new Error("hook crash");
		});

		const idx = log.emit(userInput("hello"));
		expect(idx).toBe(0);
		expect(log.len()).toBe(1);
		expect(log.deadLetters()).toHaveLength(1);
		expect(log.deadLetters()[0].error).toBe("hook crash");
	});

	it("records which hook failed", () => {
		const log = new MemLog();
		log.onEmit(() => {}); // hook 0: OK
		log.onEmit(() => {
			throw new Error("boom");
		}); // hook 1: fails

		log.emit(userInput("test"));
		expect(log.deadLetters()).toHaveLength(1);
		expect(log.deadLetters()[0].hookIndex).toBe(1);
	});

	it("working hooks still fire after a failed hook", () => {
		const log = new MemLog();
		const received: string[] = [];
		log.onEmit(() => {
			throw new Error("fail");
		});
		log.onEmit((e) => received.push(e.kind));

		log.emit(userInput("test"));
		expect(received).toEqual(["user.input"]);
	});
});

// ===========================================================================
// Direction (sensory-motor bus)
// ===========================================================================

describe("MemLog — direction filtering", () => {
	it("events carry inbound/outbound direction", () => {
		const log = new MemLog();
		log.emit(userInput("hello")); // inbound
		log.emit(assistantOutput("hi")); // outbound

		expect(log.since(0)[0].direction).toBe("inbound");
		expect(log.since(0)[1].direction).toBe("outbound");
	});

	it("byDirection filter works", () => {
		const log = new MemLog();
		const inbound: string[] = [];
		log.subscribe(byDirection("inbound"), (e) => inbound.push(e.kind));

		log.emit(userInput("hello"));
		log.emit(assistantOutput("hi"));
		log.emit(toolCalled("file_edit"));

		expect(inbound).toEqual(["user.input"]);
	});
});

// ===========================================================================
// Versioning
// ===========================================================================

describe("MemLog — event versioning", () => {
	it("default version is 1", () => {
		const log = new MemLog();
		log.emit(userInput("hello"));
		expect(log.since(0)[0].version).toBe(1);
	});

	it("custom version is preserved", () => {
		const log = new MemLog();
		log.emit(userInput("hello", { version: 2 }));
		expect(log.since(0)[0].version).toBe(2);
	});
});

// ===========================================================================
// Subscriptions
// ===========================================================================

describe("MemLog — subscriptions", () => {
	it("onEmit fires on every event", () => {
		const log = new MemLog();
		const received: string[] = [];
		log.onEmit((e) => received.push(e.kind));

		log.emit(userInput("a"));
		log.emit(assistantOutput("b"));
		expect(received).toEqual(["user.input", "assistant.output"]);
	});

	it("unsubscribe stops delivery", () => {
		const log = new MemLog();
		const received: string[] = [];
		const unsub = log.onEmit((e) => received.push(e.kind));

		log.emit(userInput("a"));
		unsub();
		log.emit(userInput("b"));
		expect(received).toEqual(["user.input"]);
	});

	it("byKind filters by typed event kind", () => {
		const log = new MemLog();
		const received: string[] = [];
		log.subscribe(byKind("memory.conflict", "memory.extracted"), (e) => received.push(e.kind));

		log.emit(userInput("hello"));
		log.emit(memoryConflict());
		log.emit(toolCalled("bash"));
		expect(received).toEqual(["memory.conflict"]);
	});

	it("bySource filters by source", () => {
		const log = new MemLog();
		const received: string[] = [];
		log.subscribe(bySource("supervisor"), (e) => received.push(e.kind));

		log.emit(agentSpawned("a1", "jade"));
		log.emit(userInput("hello"));
		expect(received).toEqual(["agent.spawned"]);
	});

	it("byTrace filters by trace ID", () => {
		const log = new MemLog();
		const received: string[] = [];
		log.subscribe(byTrace("t1"), (e) => received.push(e.kind));

		log.emit(userInput("a", { traceId: "t1" }));
		log.emit(userInput("b", { traceId: "t2" }));
		log.emit(userInput("c", { traceId: "t1" }));
		expect(received).toEqual(["user.input", "user.input"]);
	});
});

// ===========================================================================
// Cursor — snapshot consumer position
// ===========================================================================

describe("Cursor", () => {
	it("poll returns new events and advances position", () => {
		const log = new MemLog();
		const cursor = new Cursor();

		log.emit(userInput("a"));
		log.emit(userInput("b"));

		const batch1 = cursor.poll(log);
		expect(batch1).toHaveLength(2);
		expect(cursor.pos).toBe(2);

		log.emit(userInput("c"));
		const batch2 = cursor.poll(log);
		expect(batch2).toHaveLength(1);
		expect(cursor.pos).toBe(3);
	});

	it("poll returns empty when caught up", () => {
		const log = new MemLog();
		const cursor = new Cursor();

		log.emit(userInput("a"));
		cursor.poll(log);

		expect(cursor.poll(log)).toHaveLength(0);
	});

	it("reset goes back to beginning", () => {
		const log = new MemLog();
		const cursor = new Cursor();

		log.emit(userInput("a"));
		cursor.poll(log);
		cursor.reset();

		expect(cursor.poll(log)).toHaveLength(1);
	});

	it("late joiner catches up via poll", () => {
		const log = new MemLog();
		log.emit(userInput("a"));
		log.emit(userInput("b"));

		// Cursor created after events already emitted
		const cursor = new Cursor();
		const events = cursor.poll(log);
		expect(events).toHaveLength(2);
	});
});

// ===========================================================================
// Causal chains
// ===========================================================================

describe("MemLog — causal chains", () => {
	it("parentId links cause to effect", () => {
		const log = new MemLog();
		log.emit(userInput("fix auth", { id: "e1" }));
		log.emit({
			kind: "assistant.output",
			data: { text: "fixing...", model: "m" },
			source: "assistant",
			direction: "outbound",
			parentId: "e1",
		});

		const events = log.since(0);
		expect(events[1].parentId).toBe("e1");
	});

	it("traceId groups related events", () => {
		const log = new MemLog();
		log.emit(userInput("a", { traceId: "trace-1" }));
		log.emit({
			kind: "tool.called",
			data: { toolCallId: "tc1", toolName: "bash", args: {} },
			source: "assistant",
			direction: "outbound",
			traceId: "trace-1",
		});

		const events = log.since(0);
		expect(events[0].traceId).toBe("trace-1");
		expect(events[1].traceId).toBe("trace-1");
	});
});

// ===========================================================================
// Replay pattern
// ===========================================================================

describe("MemLog — replay + live subscription", () => {
	it("catch-up via since() then go live via onEmit()", () => {
		const log = new MemLog();
		log.emit(userInput("before-subscribe"));

		const all: string[] = [];

		// Replay
		for (const e of log.since(0)) all.push(e.kind);

		// Live
		log.onEmit((e) => all.push(e.kind));
		log.emit(assistantOutput("after-subscribe"));

		expect(all).toEqual(["user.input", "assistant.output"]);
	});
});
