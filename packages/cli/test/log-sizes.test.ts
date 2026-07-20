import { makeTestDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { SqliteSessionStore } from "@dpopsuev/alef-storage/sqlite/session";
import { getSessionPayloadStats } from "@dpopsuev/alef-storage/sqlite/size-stats";
import { afterEach, describe, expect, it } from "vitest";

describe("session payload size stats", { tags: ["unit"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("aggregates MB by type and contrasts legacy vs bounded warm", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const store = await SqliteSessionStore.create(client, "/tmp/log-sizes");
		await store.append({
			bus: "event",
			type: "context.assemble",
			correlationId: "c1",
			payload: { messages: [{ content: "x".repeat(50_000) }] },
			timestamp: 1,
		});
		await store.append({
			bus: "event",
			type: "llm.input",
			correlationId: "c1",
			payload: { text: "hi" },
			timestamp: 2,
		});
		await store.append({
			bus: "notification",
			type: "tui:dispatch",
			correlationId: "c1",
			payload: { ok: true },
			timestamp: 3,
		});

		const stats = await getSessionPayloadStats(client, store.id, 5);

		expect(stats.sessionId).toBe(store.id);
		expect(stats.byType[0]?.type).toBe("context.assemble");
		expect(stats.byType[0]?.bytes).toBeGreaterThan(40_000);
		expect(stats.legacyWarm.bytes).toBeGreaterThan(stats.boundedWarm.bytes);
		expect(stats.boundedWarm.count).toBe(1);
		expect(stats.preview.count).toBe(1);
		expect(stats.preview.bytes).toBeLessThan(1000);
	});
});
