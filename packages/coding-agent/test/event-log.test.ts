/**
 * Tests for the EventLog — append-only event log with sequential indexing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { byKind, bySource, byTrace, createEvent, EVENT_KINDS, MemLog } from "../src/board/event-log.js";

describe("MemLog", () => {
	let log: MemLog;

	beforeEach(() => {
		log = new MemLog();
	});

	// =====================================================================
	// Emit and read
	// =====================================================================

	it("emit returns sequential index", () => {
		expect(log.emit(createEvent("test.a", "agent", { msg: "first" }))).toBe(0);
		expect(log.emit(createEvent("test.b", "agent", { msg: "second" }))).toBe(1);
		expect(log.emit(createEvent("test.c", "agent", { msg: "third" }))).toBe(2);
		expect(log.len()).toBe(3);
	});

	it("events get id, timestamp, and index", () => {
		log.emit(createEvent("test", "agent", {}));
		const events = log.since(0);
		expect(events).toHaveLength(1);
		expect(events[0].id).toBeTruthy();
		expect(events[0].timestamp).toBeGreaterThan(0);
		expect(events[0].index).toBe(0);
	});

	it("since returns events from index onward", () => {
		log.emit(createEvent("a", "x", {}));
		log.emit(createEvent("b", "x", {}));
		log.emit(createEvent("c", "x", {}));

		expect(log.since(0)).toHaveLength(3);
		expect(log.since(1)).toHaveLength(2);
		expect(log.since(2)).toHaveLength(1);
		expect(log.since(3)).toHaveLength(0);
	});

	it("since with negative index returns all", () => {
		log.emit(createEvent("a", "x", {}));
		log.emit(createEvent("b", "x", {}));
		expect(log.since(-1)).toHaveLength(2);
	});

	it("since returns copies (not references)", () => {
		log.emit(createEvent("a", "x", {}));
		const a = log.since(0);
		const b = log.since(0);
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});

	// =====================================================================
	// onEmit hooks
	// =====================================================================

	it("onEmit fires on every event", () => {
		const received: string[] = [];
		log.onEmit((e) => received.push(e.kind));

		log.emit(createEvent("a", "x", {}));
		log.emit(createEvent("b", "x", {}));

		expect(received).toEqual(["a", "b"]);
	});

	it("onEmit returns unsubscribe function", () => {
		const received: string[] = [];
		const unsub = log.onEmit((e) => received.push(e.kind));

		log.emit(createEvent("a", "x", {}));
		unsub();
		log.emit(createEvent("b", "x", {}));

		expect(received).toEqual(["a"]);
	});

	it("hook errors do not break the log", () => {
		log.onEmit(() => {
			throw new Error("hook crash");
		});

		// Should not throw
		const idx = log.emit(createEvent("a", "x", {}));
		expect(idx).toBe(0);
		expect(log.len()).toBe(1);
	});

	// =====================================================================
	// subscribe with filter
	// =====================================================================

	it("subscribe filters events by kind", () => {
		const received: string[] = [];
		log.subscribe(byKind("memory.extracted", "memory.linked"), (e) => received.push(e.kind));

		log.emit(createEvent("user.input", "user", {}));
		log.emit(createEvent("memory.extracted", "librarian", {}));
		log.emit(createEvent("tool.called", "agent", {}));
		log.emit(createEvent("memory.linked", "librarian", {}));

		expect(received).toEqual(["memory.extracted", "memory.linked"]);
	});

	it("subscribe filters by source", () => {
		const received: string[] = [];
		log.subscribe(bySource("supervisor"), (e) => received.push(e.kind));

		log.emit(createEvent("agent.spawned", "supervisor", {}));
		log.emit(createEvent("user.input", "user", {}));
		log.emit(createEvent("agent.stopped", "supervisor", {}));

		expect(received).toEqual(["agent.spawned", "agent.stopped"]);
	});

	it("subscribe filters by trace", () => {
		const received: string[] = [];
		log.subscribe(byTrace("trace-123"), (e) => received.push(e.kind));

		log.emit(createEvent("a", "x", {}, undefined, "trace-123"));
		log.emit(createEvent("b", "x", {}, undefined, "trace-456"));
		log.emit(createEvent("c", "x", {}, undefined, "trace-123"));

		expect(received).toEqual(["a", "c"]);
	});

	it("subscribe returns unsubscribe", () => {
		const received: string[] = [];
		const unsub = log.subscribe(byKind("a"), (e) => received.push(e.kind));

		log.emit(createEvent("a", "x", {}));
		unsub();
		log.emit(createEvent("a", "x", {}));

		expect(received).toEqual(["a"]);
	});

	// =====================================================================
	// createEvent helper
	// =====================================================================

	it("createEvent builds event shape", () => {
		const event = createEvent("test.kind", "my-agent", { key: "value" }, "parent-1", "trace-1");
		expect(event.kind).toBe("test.kind");
		expect(event.source).toBe("my-agent");
		expect(event.data).toEqual({ key: "value" });
		expect(event.parentId).toBe("parent-1");
		expect(event.traceId).toBe("trace-1");
	});

	// =====================================================================
	// Event kinds constants
	// =====================================================================

	it("EVENT_KINDS has all expected categories", () => {
		expect(EVENT_KINDS.USER_INPUT).toBe("user.input");
		expect(EVENT_KINDS.ASSISTANT_OUTPUT).toBe("assistant.output");
		expect(EVENT_KINDS.AGENT_SPAWNED).toBe("agent.spawned");
		expect(EVENT_KINDS.MEMORY_EXTRACTED).toBe("memory.extracted");
		expect(EVENT_KINDS.MEMORY_CONFLICT).toBe("memory.conflict");
		expect(EVENT_KINDS.CONTRACT_BREAKPOINT).toBe("contract.breakpoint");
		expect(EVENT_KINDS.BUILD_STARTED).toBe("system.build.started");
	});

	// =====================================================================
	// Causal chains (parentId)
	// =====================================================================

	it("events can form causal chains via parentId", () => {
		const idx0 = log.emit(createEvent("user.input", "user", { text: "fix auth" }));
		const events0 = log.since(idx0);
		const parentId = events0[0].id;

		log.emit(createEvent("assistant.output", "agent", { text: "I will fix auth" }, parentId));
		log.emit(createEvent("tool.called", "agent", { tool: "file_edit" }, parentId));

		const all = log.since(0);
		expect(all[1].parentId).toBe(parentId);
		expect(all[2].parentId).toBe(parentId);
	});

	// =====================================================================
	// Replay pattern: catch-up subscriber
	// =====================================================================

	it("new subscriber can replay + live via since() + onEmit()", () => {
		// Emit some events before subscriber joins
		log.emit(createEvent("a", "x", {}));
		log.emit(createEvent("b", "x", {}));

		// Subscriber joins late — catches up via since(), then goes live
		const received: string[] = [];
		const cursor = 0;

		// Replay
		for (const event of log.since(cursor)) {
			received.push(event.kind);
		}

		// Live
		log.onEmit((e) => received.push(e.kind));
		log.emit(createEvent("c", "x", {}));

		expect(received).toEqual(["a", "b", "c"]);
	});
});
