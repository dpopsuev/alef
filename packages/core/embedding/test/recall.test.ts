import { type Client, createClient } from "@libsql/client";
import { applySchema } from "@dpopsuev/alef-storage/sqlite/schema";
import { SqliteSessionStore } from "@dpopsuev/alef-storage/sqlite/session";
import { SqliteSummaryStore } from "@dpopsuev/alef-storage/sqlite/summary";
import { afterEach, describe, expect, it } from "vitest";
import { RecallStore } from "../src/recall.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	await applySchema(client);
	return client;
}

describe("RecallStore", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("sets and searches event embeddings", async () => {
		const client = await makeClient();
		clients.push(client);
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		const recall = new RecallStore(client);

		await store.append({
			bus: "command",
			type: "fs.read",
			correlationId: "corr-1",
			payload: { path: "/tmp" },
			timestamp: 1000,
		});
		await store.append({
			bus: "command",
			type: "shell.exec",
			correlationId: "corr-2",
			payload: { cmd: "ls" },
			timestamp: 1001,
		});

		const eventsResult = await client.execute({
			sql: "SELECT rowid FROM events WHERE session_id = ? ORDER BY rowid",
			args: [store.id],
		});
		const rowids = eventsResult.rows.map((r) => Number(r.rowid));

		await recall.setEventEmbedding(rowids[0], [1, 0, 0, 0]);
		await recall.setEventEmbedding(rowids[1], [0, 1, 0, 0]);

		const results = await recall.searchEvents(store.id, [0.9, 0.1, 0, 0], 2);
		expect(results).toHaveLength(2);
		expect(results[0].correlationId).toBe("corr-1");
		expect(results[0].similarity).toBeGreaterThan(0.9);
		expect(results[1].correlationId).toBe("corr-2");
		expect(results[1].similarity).toBeLessThan(0.5);
	});

	it("turnScores returns max similarity per correlation", async () => {
		const client = await makeClient();
		clients.push(client);
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		const recall = new RecallStore(client);

		await store.append({
			bus: "command",
			type: "fs.read",
			correlationId: "turn-A",
			payload: {},
			timestamp: 1000,
		});
		await store.append({
			bus: "event",
			type: "fs.read",
			correlationId: "turn-A",
			payload: {},
			timestamp: 1001,
		});

		const eventsResult = await client.execute({
			sql: "SELECT rowid FROM events WHERE session_id = ? ORDER BY rowid",
			args: [store.id],
		});
		const rowids = eventsResult.rows.map((r) => Number(r.rowid));

		await recall.setEventEmbedding(rowids[0], [1, 0, 0, 0]);
		await recall.setEventEmbedding(rowids[1], [0.5, 0.5, 0, 0]);

		const scores = await recall.turnScores(store.id, [1, 0, 0, 0]);
		expect(scores.get("turn-A")).toBeGreaterThan(0.9);
	});

	it("searches session summaries by embedding", async () => {
		const client = await makeClient();
		clients.push(client);
		const s1 = await SqliteSessionStore.create(client, "/tmp/cwd");
		const s2 = await SqliteSessionStore.create(client, "/tmp/cwd");
		const summaries = new SqliteSummaryStore(client);
		const recall = new RecallStore(client);

		await summaries.write({
			id: s1.id,
			model: "m1",
			started_at: "",
			duration_ms: 0,
			turns: 5,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});
		await summaries.write({
			id: s2.id,
			model: "m2",
			started_at: "",
			duration_ms: 0,
			turns: 3,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});

		await recall.setSummaryEmbedding(s1.id, [1, 0, 0, 0]);
		await recall.setSummaryEmbedding(s2.id, [0, 1, 0, 0]);

		const results = await recall.searchSessions([0.9, 0.1, 0, 0], 2);
		expect(results).toHaveLength(2);
		expect(results[0].sessionId).toBe(s1.id);
		expect(results[0].similarity).toBeGreaterThan(0.9);
	});

	it("returns empty results when no embeddings exist", async () => {
		const client = await makeClient();
		clients.push(client);
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		const recall = new RecallStore(client);

		await store.append({
			bus: "command",
			type: "fs.read",
			correlationId: "corr-1",
			payload: {},
			timestamp: 1000,
		});

		const results = await recall.searchEvents(store.id, [1, 0, 0, 0]);
		expect(results).toHaveLength(0);
	});
});
