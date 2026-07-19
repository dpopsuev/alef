import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorageFactory } from "../src/factory.js";
import {
	MAX_PAYLOAD_BYTES,
	parseEventPayload,
	previewEventLimit,
} from "../src/sqlite/event-load.js";
import { makeTestDatabase } from "../src/sqlite/database.js";
import { SqliteSessionStore } from "../src/sqlite/session.js";

describe("event-load bounds", { tags: ["unit"] }, () => {
	it("stubs oversized non-dialog payloads", () => {
		const raw = "x".repeat(MAX_PAYLOAD_BYTES + 1);
		const stub = parseEventPayload(JSON.stringify({ blob: raw }), "context.assemble");
		expect(stub._truncated).toBe(true);
		expect(stub._bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
	});

	it("parses large llm.input payloads", () => {
		const text = "y".repeat(MAX_PAYLOAD_BYTES + 10);
		const parsed = parseEventPayload(JSON.stringify({ text }), "llm.input");
		expect(parsed.text).toBe(text);
		expect(parsed._truncated).toBeUndefined();
	});

	it("previewEventLimit scales with turns", () => {
		expect(previewEventLimit(1)).toBe(200);
		expect(previewEventLimit(10)).toBe(320);
	});
});

describe("bounded preview and warm", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("getSessionPreview ignores fat context.assemble rows", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);
		const store = await SqliteSessionStore.create(client, "/tmp/fat-preview");

		const fat = { messages: [{ role: "user", content: "z".repeat(600_000) }] };
		await store.append({
			bus: "event",
			type: "context.assemble",
			correlationId: "c1",
			payload: fat,
			timestamp: 500,
		});
		await store.append({
			bus: "event",
			type: "llm.input",
			correlationId: "c1",
			payload: { text: "hello" },
			timestamp: 1000,
		});
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: "c1",
			payload: { text: "hi" },
			timestamp: 2000,
		});

		const preview = await factory.sessionPreview().getSessionPreview(store.id, 5);
		expect(preview).toEqual([
			{ kind: "user", text: "hello" },
			{ kind: "assistant", text: "hi" },
		]);
	});

	it("resume warm excludes context.assemble and stubs fat checkpoints", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const store = await SqliteSessionStore.create(client, "/tmp/fat-warm");

		await store.append({
			bus: "event",
			type: "context.assemble",
			correlationId: "c1",
			payload: { messages: [{ content: "a".repeat(100) }] },
			timestamp: 100,
		});
		await store.append({
			bus: "event",
			type: "llm.input",
			correlationId: "c1",
			payload: { text: "q" },
			timestamp: 200,
		});
		const hugeHistory = { conversationHistory: [{ role: "user", content: "b".repeat(600_000) }] };
		await store.append({
			bus: "internal",
			type: "llm.checkpoint",
			correlationId: "c1",
			payload: hugeHistory,
			timestamp: 300,
		});

		const resumed = await SqliteSessionStore.resume(client, "/tmp/fat-warm", store.id);
		const events = await resumed.events();
		expect(events.some((e) => e.type === "context.assemble")).toBe(false);
		expect(events.some((e) => e.type === "llm.input")).toBe(true);
		const checkpoint = events.find((e) => e.type === "llm.checkpoint");
		expect(checkpoint?.payload._truncated).toBe(true);
	});
});
