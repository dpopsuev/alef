import { afterEach, describe, expect, it } from "vitest";
import { makeTestDatabase } from "../src/database.js";
import { SqliteSessionStore } from "../src/sqlite-session.js";
import { SqliteStorageFactory } from "../src/factory.js";

describe("session preview — realistic fixture", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("previews a session with real event bus/type patterns", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);
		const store = await SqliteSessionStore.create(client, "/tmp/fixture");

		const events = [
			{ bus: "event", type: "adapter.loaded", correlationId: "boot", payload: { name: "fs" }, timestamp: 1000 },
			{ bus: "event", type: "adapter.loaded", correlationId: "boot", payload: { name: "llm" }, timestamp: 1001 },
			{ bus: "event", type: "llm.input", correlationId: "t1", payload: { text: "Smoke test, spawn two subagents.", sender: "human" }, timestamp: 2000 },
			{ bus: "notification", type: "llm.result", correlationId: "t1", payload: { text: "I'll spawn two agents to explore the codebase.", role: "assistant" }, timestamp: 3000 },
			{ bus: "command", type: "agent.spawn", correlationId: "t1", payload: { blueprintPath: "coding" }, timestamp: 3500 },
			{ bus: "command", type: "fs.read", correlationId: "t2", payload: { path: "/tmp/test.ts" }, timestamp: 4000 },
			{ bus: "notification", type: "llm.chunk", correlationId: "t2", payload: { text: "chunk..." }, timestamp: 4500 },
			{ bus: "notification", type: "llm.result", correlationId: "t2", payload: { text: "The analysis is complete.", role: "assistant" }, timestamp: 5000 },
			{ bus: "event", type: "llm.input", correlationId: "t3", payload: { text: "What did you find?", sender: "human" }, timestamp: 6000 },
		] as const;

		for (const e of events) {
			await store.append({ ...e, payload: { ...e.payload } });
		}

		const preview = await factory.sessionPreview().getSessionPreview!(store.id, 10);

		expect(preview.length).toBeGreaterThan(0);

		const hasUserMessage = preview.some((l) => l.includes("▸") && l.includes("Smoke test"));
		expect(hasUserMessage).toBe(true);

		const hasAgentReply = preview.some((l) => l.includes("◂") && l.includes("spawn two agents"));
		expect(hasAgentReply).toBe(true);

		const hasToolCall = preview.some((l) => l.includes("●") && l.includes("agent.spawn"));
		expect(hasToolCall).toBe(true);

		const hasSecondUser = preview.some((l) => l.includes("▸") && l.includes("What did you find"));
		expect(hasSecondUser).toBe(true);
	});

	it("shows most recent activity when session has many events", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);
		const store = await SqliteSessionStore.create(client, "/tmp/fixture");

		for (let i = 0; i < 50; i++) {
			await store.append({ bus: "event", type: "llm.input", correlationId: `t${i}`, payload: { text: `question ${i}` }, timestamp: i * 1000 });
			await store.append({ bus: "notification", type: "llm.result", correlationId: `t${i}`, payload: { text: `answer ${i}` }, timestamp: i * 1000 + 500 });
		}

		const preview = await factory.sessionPreview().getSessionPreview!(store.id, 6);

		expect(preview.length).toBe(6);
		expect(preview[preview.length - 1]).toContain("answer 49");
	});
});
