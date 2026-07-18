import { describe, expect, it, vi } from "vitest";
import type { SessionStore, StorageRecord } from "@dpopsuev/alef-session/storage";
import { appendDisplayBlocks, prependSessionHistory } from "../src/views/session-history.js";
import type { ChatLog } from "../src/views/chat-log.js";

function fakeWriter() {
	const calls: string[] = [];
	const children: unknown[] = [];
	const writer = {
		addNotice: (text: string) => {
			calls.push(`notice:${text}`);
			children.push({ kind: "notice", text });
		},
		addUserMessage: (text: string) => {
			calls.push(`user:${text}`);
			children.push({ kind: "user" });
		},
		addAgentReply: (text: string) => {
			calls.push(`assistant:${text}`);
			children.push({ kind: "assistant" });
		},
		addCompletedToolBlock: (name: string, keyArg: string) => {
			calls.push(`tool:${name}:${keyArg}`);
			children.push({ kind: "tool" });
		},
		container: {
			children,
			insertAt: (index: number, child: unknown) => {
				children.splice(index, 0, child);
			},
			removeChild: (child: unknown) => {
				const index = children.indexOf(child);
				if (index >= 0) children.splice(index, 1);
			},
		},
	};
	return { writer: writer as unknown as ChatLog, calls, children };
}

function storeWith(events: StorageRecord[]): SessionStore {
	return {
		id: "s1",
		path: "/tmp/s1.jsonl",
		async append() {},
		async events() {
			return events;
		},
		async turns() {
			return [];
		},
		async hitCounts() {
			return new Map();
		},
		async adapterHistory() {
			return [];
		},
		name: () => undefined,
		nameSource: () => undefined,
		async setName() {},
		tags: () => [],
		tagsSource: () => undefined,
		async setTags() {},
		searchBlob: () => undefined,
		async setSearchBlob() {},
		async isEmpty() {
			return !events.some((e) => e.type === "llm.input");
		},
		async destroy() {},
	};
}

describe("appendDisplayBlocks", { tags: ["unit"] }, () => {
	it("maps projector blocks onto ChatLog APIs", () => {
		const { writer, calls } = fakeWriter();
		appendDisplayBlocks(writer, [
			{ kind: "plan", phase: "open", desired: "ship it", lines: ["1/2 done"] },
			{ kind: "user", text: "hello" },
			{ kind: "assistant", text: "hi" },
			{ kind: "tool", name: "fs.read", summary: "/tmp/a.ts" },
		]);
		expect(calls[0]).toContain("◆ plan [open] ship it");
		expect(calls).toContain("user:hello");
		expect(calls).toContain("assistant:hi");
		expect(calls).toContain("tool:fs.read:/tmp/a.ts");
	});
});

describe("prependSessionHistory", { tags: ["unit"] }, () => {
	it("projects store events into chat history", async () => {
		const { writer, calls } = fakeWriter();
		const store = storeWith([
			{
				bus: "event",
				type: "llm.input",
				correlationId: "c1",
				payload: { text: "first question" },
				timestamp: 1,
			},
			{
				bus: "command",
				type: "fs.read",
				correlationId: "c1",
				payload: { path: "/tmp/f.ts" },
				timestamp: 2,
			},
			{
				bus: "command",
				type: "llm.response",
				correlationId: "c1",
				payload: { text: "first answer" },
				timestamp: 3,
			},
		]);

		await prependSessionHistory(store, writer, { maxTurns: 5 });

		expect(calls.some((c) => c.startsWith("notice:Resumed"))).toBe(true);
		expect(calls).toContain("user:first question");
		expect(calls).toContain("tool:fs.read:/tmp/f.ts");
		expect(calls).toContain("assistant:first answer");
	});

	it("loads dialog even when the newest events are resume boot noise", async () => {
		const { writer, calls } = fakeWriter();
		const noise: StorageRecord[] = Array.from({ length: 60 }, (_, i) => ({
			bus: "event" as const,
			type: "adapter.loaded",
			correlationId: `n${i}`,
			payload: { name: `adapter-${i}` },
			timestamp: 100 + i,
		}));
		const store = storeWith([
			{
				bus: "event",
				type: "llm.input",
				correlationId: "c1",
				payload: { text: "Spawn a single subagent" },
				timestamp: 1,
			},
			{
				bus: "command",
				type: "llm.response",
				correlationId: "c1",
				payload: { text: "Spawned child-1" },
				timestamp: 2,
			},
			...noise,
		]);

		await prependSessionHistory(store, writer, { maxTurns: 5 });

		expect(calls).toContain("user:Spawn a single subagent");
		expect(calls).toContain("assistant:Spawned child-1");
	});

	it("paints history in yielded chunks and drops the loading marker", async () => {
		const { writer, calls, children } = fakeWriter();
		const chunkSpy = vi.fn();
		const store = storeWith([
			{
				bus: "event",
				type: "llm.input",
				correlationId: "c1",
				payload: { text: "q1" },
				timestamp: 1,
			},
			{
				bus: "command",
				type: "llm.response",
				correlationId: "c1",
				payload: { text: "a1" },
				timestamp: 2,
			},
			{
				bus: "event",
				type: "llm.input",
				correlationId: "c2",
				payload: { text: "q2" },
				timestamp: 3,
			},
			{
				bus: "command",
				type: "llm.response",
				correlationId: "c2",
				payload: { text: "a2" },
				timestamp: 4,
			},
		]);

		await prependSessionHistory(store, writer, { maxTurns: 5, chunkSize: 1, onChunk: chunkSpy });

		expect(calls.some((c) => c.includes("Loading session"))).toBe(true);
		expect(calls.some((c) => c.startsWith("notice:Resumed"))).toBe(true);
		expect(children.some((child) => (child as { text?: string }).text === "Loading session…")).toBe(false);
		expect(chunkSpy.mock.calls.length).toBeGreaterThan(2);
		expect(calls).toContain("user:q1");
		expect(calls).toContain("user:q2");
	});

	it("aborts before painting when signal is aborted during fetch", async () => {
		const { writer, calls } = fakeWriter();
		const controller = new AbortController();
		const store = storeWith([
			{
				bus: "event",
				type: "llm.input",
				correlationId: "c1",
				payload: { text: "should not paint" },
				timestamp: 1,
			},
			{
				bus: "command",
				type: "llm.response",
				correlationId: "c1",
				payload: { text: "nope" },
				timestamp: 2,
			},
		]);
		const slowStore = {
			...store,
			async events() {
				controller.abort();
				return store.events();
			},
		};

		await prependSessionHistory(slowStore, writer, { maxTurns: 5, signal: controller.signal });

		expect(calls).not.toContain("user:should not paint");
		expect(calls.some((c) => c.startsWith("notice:Resumed"))).toBe(false);
	});
});
