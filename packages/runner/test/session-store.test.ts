import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, type StorageRecord } from "../src/session-store.js";

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
	return { bus: "motor", type, correlationId, payload, timestamp: Date.now() };
}

function senseRecord(type: string, correlationId: string, payload: Record<string, unknown> = {}): StorageRecord {
	return { bus: "sense", type, correlationId, payload, timestamp: Date.now() };
}

describe("SessionStore.create", () => {
	it("creates a new session with a short ID", async () => {
		const store = await SessionStore.create(tmpCwd());
		expect(store.id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("starts with empty events", async () => {
		const store = await SessionStore.create(tmpCwd());
		expect(await store.events()).toHaveLength(0);
	});
});

describe("SessionStore.append + events", () => {
	it("round-trips StorageRecords", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1", { path: "src/auth.ts" }));
		await store.append(senseRecord("fs.read", "c-1", { content: "export function login" }));

		const events = await store.events();
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ bus: "motor", type: "fs.read", correlationId: "c-1" });
		expect(events[1]).toMatchObject({ bus: "sense", type: "fs.read", correlationId: "c-1" });
	});

	it("persists across store re-opens", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("dialog.message", "c-1"));

		const resumed = await SessionStore.resume(cwd, store.id);
		const events = await resumed.events();
		expect(events[0].type).toBe("dialog.message");
	});
});

describe("SessionStore.turns()", () => {
	it("groups events by correlationId", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		await store.append(senseRecord("fs.read", "c-1"));
		await store.append(motorRecord("shell.exec", "c-2"));
		await store.append(senseRecord("shell.exec", "c-2"));

		const turns = await store.turns();
		expect(turns).toHaveLength(2);
		expect(turns[0].id).toBe("c-1");
		expect(turns[0].events).toHaveLength(2);
		expect(turns[1].id).toBe("c-2");
	});

	it("assigns ascending turnIndex", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("dialog.message", "c-1"));
		await store.append(motorRecord("dialog.message", "c-2"));

		const turns = await store.turns();
		expect(turns[0].turnIndex).toBe(0);
		expect(turns[1].turnIndex).toBe(1);
	});

	it("assigns typeWeight from event types", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("fs.write", "c-1")); // weight 2.0
		await store.append(motorRecord("dialog.message", "c-1")); // weight 0.8

		const [turn] = await store.turns();
		expect(turn.typeWeight).toBe(2.0); // max
	});

	it("excludes internal records from turns", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
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
		expect(turns[0].events).toHaveLength(1); // only the motor event, not internal
	});
});

describe("SessionStore.hitCounts()", () => {
	it("returns zero counts when no window.assembled records", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append(motorRecord("fs.read", "c-1"));
		const counts = await store.hitCounts();
		expect(counts.size).toBe(0);
	});

	it("counts inclusions from window.assembled records", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
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
	});
});

describe("SessionStore.resume", () => {
	it("throws for unknown session ID", async () => {
		await expect(SessionStore.resume(tmpCwd(), "deadbeef")).rejects.toThrow(/not found/);
	});
});

describe("SessionStore.resumeLatest", () => {
	it("returns null when no sessions exist", async () => {
		expect(await SessionStore.resumeLatest(tmpCwd())).toBeNull();
	});

	it("returns the most recently created session", async () => {
		const cwd = tmpCwd();
		await SessionStore.create(cwd);
		const s2 = await SessionStore.create(cwd);
		const latest = await SessionStore.resumeLatest(cwd);
		expect(latest?.id).toBe(s2.id);
	});
});

describe("SessionStore.list", () => {
	it("returns empty list when no sessions", async () => {
		expect(await SessionStore.list(tmpCwd())).toHaveLength(0);
	});

	it("lists all sessions for a cwd", async () => {
		const cwd = tmpCwd();
		await SessionStore.create(cwd);
		await SessionStore.create(cwd);
		expect(await SessionStore.list(cwd)).toHaveLength(2);
	});
});

describe("SessionStore.turns() — token cost estimation", () => {
	it("uses _display.text length for cost when available (clean content estimate)", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

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
		expect(turns[0].tokenCost).toBe(100);
	});

	it("does NOT use totalTokens as per-turn cost (totalTokens is cumulative context size, not per-turn)", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

		const realUsage = { input: 1800, output: 420, cacheRead: 0, cacheWrite: 0, totalTokens: 2220 };

		await store.append(senseRecord("dialog.message", "c-1", { text: "hi" }));
		await store.append({
			bus: "motor",
			type: "dialog.message",
			correlationId: "c-1",
			payload: { text: "hello", conversationHistory: [{ role: "user", content: "hi" }], usage: realUsage },
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		// Must NOT be totalTokens (2220) — that is the cumulative context, not this turn's cost.
		expect(turns[0].tokenCost).not.toBe(2220);
		// Should be derived from actual content: "hi" + "hello" = 10 chars → ~3 tokens
		expect(turns[0].tokenCost).toBeLessThan(50);
	});

	it("falls back to char/4 when no usage is present (ScriptedLLMOrgan / first turn)", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

		await store.append(senseRecord("dialog.message", "c-1", { text: "hi" }));
		await store.append({
			bus: "motor",
			type: "dialog.message",
			correlationId: "c-1",
			payload: { text: "hello" }, // no usage field
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns).toHaveLength(1);
		// char/4 estimate — just verify it's a positive number and not the real usage value
		expect(turns[0].tokenCost).toBeGreaterThan(0);
		expect(turns[0].tokenCost).not.toBe(2220);
	});

	it("ignores zero totalTokens and falls back to char/4", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

		await store.append(senseRecord("dialog.message", "c-1", { text: "hi" }));
		await store.append({
			bus: "motor",
			type: "dialog.message",
			correlationId: "c-1",
			payload: { text: "hello", usage: { totalTokens: 0 } },
			timestamp: Date.now(),
		});

		const turns = await store.turns();
		expect(turns[0].tokenCost).toBeGreaterThan(0);
	});
});
