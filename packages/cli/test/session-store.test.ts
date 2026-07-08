import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageRecord } from "@dpopsuev/alef-session/storage";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { buildSessionIndex } from "@dpopsuev/alef-session/tracing";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
function tmpCwd(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-session-"));
	tempDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function motorRecord(type: string, correlationId: string, payload: Record<string, unknown> = {}): StorageRecord {
	return { bus: "command", type, correlationId, payload, timestamp: Date.now() };
}

function senseRecord(type: string, correlationId: string, payload: Record<string, unknown> = {}): StorageRecord {
	return { bus: "event", type, correlationId, payload, timestamp: Date.now() };
}

describe("JsonlSessionStore.create", { tags: ["unit"] }, () => {
	it("creates a new session with a short ID", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		expect(store.id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("starts with empty events", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		expect(await store.events()).toHaveLength(0);
	});
});

describe("JsonlSessionStore.append + events", { tags: ["unit"] }, () => {
	it("round-trips StorageRecords", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1", { path: "src/auth.ts" }));
		await store.append(senseRecord("fs.read", "c-1", { content: "export function login" }));

		const events = await store.events();
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ bus: "command", type: "fs.read", correlationId: "c-1" });
		expect(events[1]).toMatchObject({ bus: "event", type: "fs.read", correlationId: "c-1" });
	});

	it("persists across store re-opens", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("llm.response", "c-1"));

		const resumed = await JsonlSessionStore.resume(cwd, store.id);
		const events = await resumed.events();
		expect(events[0]!.type).toBe("llm.response");
	});
});

describe("JsonlSessionStore.turns()", { tags: ["unit"] }, () => {
	it("groups events by correlationId", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		await store.append(senseRecord("fs.read", "c-1"));
		await store.append(motorRecord("shell.exec", "c-2"));
		await store.append(senseRecord("shell.exec", "c-2"));

		const turns = await store.turns();
		expect(turns).toHaveLength(2);
		expect(turns[0]!.id).toBe("c-1");
		expect(turns[0]!.events).toHaveLength(2);
		expect(turns[1]!.id).toBe("c-2");
	});

	it("assigns ascending turnIndex", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("llm.response", "c-1"));
		await store.append(motorRecord("llm.response", "c-2"));

		const turns = await store.turns();
		expect(turns[0]!.turnIndex).toBe(0);
		expect(turns[1]!.turnIndex).toBe(1);
	});

	it("assigns typeWeight from event types", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.write", "c-1"));
		await store.append(motorRecord("llm.response", "c-1"));

		const [turn] = await store.turns();
		expect(turn!.typeWeight).toBe(0.5);
	});

	it("excludes internal records from turns", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		await store.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: "c-1",
			payload: { includedTurnIds: ["c-1"], queryTokens: [], budgetUsed: 100, budgetTotal: 1000 },
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		expect(turns[0]!.events).toHaveLength(1);

		const records = await store.events();
		const index = buildSessionIndex(records);
		expect(index.turns).toHaveLength(1);
		expect(index.windowAssemblies.size).toBe(1);
	});
});

describe("JsonlSessionStore.hitCounts()", { tags: ["unit"] }, () => {
	it("returns zero counts when no window.assembled records", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		const counts = await store.hitCounts();
		expect(counts.size).toBe(0);
	});

	it("counts inclusions from window.assembled records", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: "c-5",
			payload: { includedTurnIds: ["c-1", "c-2"], queryTokens: [], budgetUsed: 100, budgetTotal: 1000 },
			timestamp: Date.now(),
		});
		await store.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: "c-6",
			payload: { includedTurnIds: ["c-1", "c-3"], queryTokens: [], budgetUsed: 100, budgetTotal: 1000 },
			timestamp: Date.now(),
		});

		const counts = await store.hitCounts();
		expect(counts.get("c-1")).toBe(2);
		expect(counts.get("c-2")).toBe(1);
		expect(counts.get("c-3")).toBe(1);

		const records = await store.events();
		const index = buildSessionIndex(records);
		expect(index.hitCounts.get("c-1")).toBe(2);
		expect(index.hitCounts.get("c-2")).toBe(1);
		expect(index.hitCounts.get("c-3")).toBe(1);
	});
});

describe("JsonlSessionStore.resume", { tags: ["unit"] }, () => {
	it("throws for unknown session ID", async () => {
		await expect(JsonlSessionStore.resume(tmpCwd(), "deadbeef")).rejects.toThrow(/not found/);
	});
});

describe("JsonlSessionStore.resumeLatest", { tags: ["unit"] }, () => {
	it("returns null when no sessions exist", async () => {
		expect(await JsonlSessionStore.resumeLatest(tmpCwd())).toBeNull();
	});

	it("returns the most recently created session", async () => {
		const cwd = tmpCwd();
		await JsonlSessionStore.create(cwd);
		const s2 = await JsonlSessionStore.create(cwd);
		const latest = await JsonlSessionStore.resumeLatest(cwd);
		expect(latest?.id).toBe(s2.id);
	});
});

describe("JsonlSessionStore.list", { tags: ["unit"] }, () => {
	it("returns empty list when no sessions", async () => {
		expect(await JsonlSessionStore.list(tmpCwd())).toHaveLength(0);
	});

	it("lists all sessions for a cwd", async () => {
		const cwd = tmpCwd();
		await JsonlSessionStore.create(cwd);
		await JsonlSessionStore.create(cwd);
		expect(await JsonlSessionStore.list(cwd)).toHaveLength(2);
	});
});

describe("JsonlSessionStore.turns() — token cost estimation", { tags: ["unit"] }, () => {
	it("uses _display.text length for cost when available (clean content estimate)", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);

		const displayText = "a".repeat(400); // 400 chars → 100 tokens
		await store.append(
			senseRecord("fs.read", "c-1", {
				path: "/some/file.ts",
				toolCallId: "tc-1",
				_display: { text: displayText, mimeType: "text/markdown" },
			}),
		);

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		// Cost derived from _display.text length / 4 = 100 tokens
		expect(turns[0]!.tokenCost).toBe(100);
	});

	it("does NOT use totalTokens as per-turn cost (totalTokens is cumulative context size, not per-turn)", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);

		const realUsage = { input: 1800, output: 420, cacheRead: 0, cacheWrite: 0, totalTokens: 2220 };

		await store.append(senseRecord("llm.response", "c-1", { text: "hi" }));
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: "c-1",
			payload: { text: "hello", conversationHistory: [{ role: "user", content: "hi" }], usage: realUsage },
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		// Must NOT be totalTokens (2220) — that is the cumulative context, not this turn's cost.
		expect(turns[0]!.tokenCost).not.toBe(2220);
		// Should be derived from actual content: "hi" + "hello" = 10 chars → ~3 tokens
		expect(turns[0]!.tokenCost).toBeLessThan(50);
	});

	it("falls back to char/4 when no usage is present (ScriptedLLMOrgan / first turn)", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);

		await store.append(senseRecord("llm.response", "c-1", { text: "hi" }));
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: "c-1",
			payload: { text: "hello" }, // no usage field
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		// char/4 estimate — just verify it's a positive number and not the real usage value
		expect(turns[0]!.tokenCost).toBeGreaterThan(0);
		expect(turns[0]!.tokenCost).not.toBe(2220);
	});

	it("ignores zero totalTokens and falls back to char/4", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);

		await store.append(senseRecord("llm.response", "c-1", { text: "hi" }));
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: "c-1",
			payload: { text: "hello", usage: { totalTokens: 0 } },
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns[0]!.tokenCost).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// in-memory cache + checkpoint race fix
// ---------------------------------------------------------------------------

describe("JsonlSessionStore — in-memory cache", { tags: ["unit"] }, () => {
	it("events() reflects append() synchronously without waiting for file flush", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		const record = motorRecord("fs.write", "c-1", { path: "CODEBASE.md" });

		// Fire-and-forget append — do NOT await.
		void store.append(record);

		// Immediately read — must see the record without awaiting the file write.
		const events = await store.events();
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("fs.write");
	});

	it("llm.checkpoint internal record appears in turn events", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		await store.append(motorRecord("fs.write", "c-1", { path: "x.md", toolCallId: "t1" }));
		await store.append(senseRecord("fs.write", "c-1", { applied: true, toolCallId: "t1" }));
		// Checkpoint written by onCheckpoint callback after tool round completes.
		await store.append({
			bus: "internal",
			type: "llm.checkpoint",
			correlationId: "c-1",
			payload: {
				conversationHistory: [
					{ role: "user", content: "Write docs" },
					{ role: "assistant", content: "Done." },
				],
			},
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		const checkpointEvent = turns[0]!.events.find((e) => e.type === "llm.checkpoint");
		expect(checkpointEvent).toBeDefined();
		expect(checkpointEvent?.payload.conversationHistory).toHaveLength(2);
	});

	it("resume() warms cache from JSONL so events() returns prior records", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		await store.append(senseRecord("fs.read", "c-1", { content: "hello" }));

		// Simulate restart — resume loads from file.
		const resumed = await JsonlSessionStore.resume(cwd, store.id);
		const events = await resumed.events();
		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("fs.read");
	});

	it("turnsToMessages finds llm.checkpoint conversationHistory from aborted turn", async () => {
		const { turnsToMessages } = await import("@dpopsuev/alef-session/context");
		const store = await JsonlSessionStore.create(tmpCwd());

		await store.append(motorRecord("fs.write", "c-1", { path: "CODEBASE.md" }));
		await store.append(senseRecord("fs.write", "c-1", { applied: true }));
		const history = [
			{ role: "user", content: "Write docs" },
			{ role: "assistant", content: [{ type: "toolCall", name: "fs.write" }] },
			{ role: "toolResult", content: "Applied." },
		];
		// Checkpoint written synchronously after tool round — no await on the file write.
		void store.append({
			bus: "internal",
			type: "llm.checkpoint",
			correlationId: "c-1",
			payload: { conversationHistory: history },
			timestamp: Date.now(),
		});

		// New turn reads immediately — race-free because cache is synchronous.
		const turns = await store.turns();
		const messages = turnsToMessages(turns);
		expect(messages).toBe(history); // exact same reference from checkpoint
	});
});

describe("JsonlSessionStore.name() + setName()", { tags: ["unit"] }, () => {
	it("name() returns undefined for a new session", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		expect(store.name()).toBeUndefined();
	});

	it("setName() stores the name and name() returns it", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		await store.setName("ToolShell promotion + amnesia fix");
		expect(store.name()).toBe("ToolShell promotion + amnesia fix");
	});

	it("last setName() wins (WAL)", async () => {
		const store = await JsonlSessionStore.create(tmpCwd());
		await store.setName("first name");
		await store.setName("second name");
		expect(store.name()).toBe("second name");
	});

	it("name() reads from _cache without disk I/O after resume", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await store.setName("cached name");

		const resumed = await JsonlSessionStore.resume(cwd, store.id);
		expect(resumed.name()).toBe("cached name");
	});
});
