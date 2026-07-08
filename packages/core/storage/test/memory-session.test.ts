import type { StorageRecord } from "@dpopsuev/alef-session/storage";
import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../src/memory/session.js";

function motorEvent(type: string, correlationId: string): StorageRecord {
	return { bus: "command", type, correlationId, payload: { text: `payload for ${type}` }, timestamp: Date.now() };
}

function senseEvent(type: string, correlationId: string): StorageRecord {
	return { bus: "event", type, correlationId, payload: { content: `result of ${type}` }, timestamp: Date.now() };
}

describe("InMemorySessionStore", { tags: ["unit"] }, () => {
	it("creates with 8-char id", () => {
		const store = new InMemorySessionStore();
		expect(store.id).toHaveLength(8);
		expect(store.path).toBe(`memory:${store.id}`);
	});

	it("appends and retrieves events", async () => {
		const store = new InMemorySessionStore();
		await store.append(motorEvent("fs.read", "corr-1"));
		const events = await store.events();
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("fs.read");
	});

	it("groups events into turns by correlationId", async () => {
		const store = new InMemorySessionStore();
		await store.append(motorEvent("fs.read", "turn-1"));
		await store.append(senseEvent("fs.read", "turn-1"));
		await store.append(motorEvent("fs.write", "turn-2"));
		const turns = await store.turns();
		expect(turns).toHaveLength(2);
		expect(turns[0]!.id).toBe("turn-1");
		expect(turns[0]!.events).toHaveLength(2);
	});

	it("sets and gets name", async () => {
		const store = new InMemorySessionStore();
		expect(store.name()).toBeUndefined();
		await store.setName("test session");
		expect(store.name()).toBe("test session");
	});

	it("filters adapter history by prefix", async () => {
		const store = new InMemorySessionStore();
		await store.append(motorEvent("fs.read", "c1"));
		await store.append(motorEvent("fs.write", "c1"));
		await store.append(motorEvent("shell.exec", "c2"));
		const fsHistory = await store.adapterHistory("fs");
		expect(fsHistory).toHaveLength(2);
		expect(fsHistory.every((e) => e.type.startsWith("fs."))).toBe(true);
	});

	it("tracks hit counts from window.assembled", async () => {
		const store = new InMemorySessionStore();
		await store.append(motorEvent("fs.read", "turn-1"));
		await store.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: "assembler",
			payload: { includedTurnIds: ["turn-1", "turn-1"], budgetUsed: 0, budgetTotal: 0, queryTokens: [] },
			timestamp: Date.now(),
		});
		const counts = await store.hitCounts();
		expect(counts.get("turn-1")).toBe(2);
	});

	it("returns isolated copies from events()", async () => {
		const store = new InMemorySessionStore();
		await store.append(motorEvent("fs.read", "c1"));
		const a = await store.events();
		const b = await store.events();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});
