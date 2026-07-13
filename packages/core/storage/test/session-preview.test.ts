import { afterEach, describe, expect, it } from "vitest";
import { makeTestDatabase } from "../src/sqlite/database.js";
import { SqliteSessionStore } from "../src/sqlite/session.js";
import { SqliteStorageFactory } from "../src/factory.js";

describe("session preview", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("getSessionName returns the session name", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);

		const store = await SqliteSessionStore.create(client, "/tmp/preview");
		await store.setName("my analysis session");

		const preview = factory.sessionPreview();
		const name = await preview.getSessionName(store.id);
		expect(name).toBe("my analysis session");
		expect(await preview.getSessionNameSource(store.id)).toBe("user");
	});

	it("getSessionName returns undefined for unnamed sessions", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);

		const store = await SqliteSessionStore.create(client, "/tmp/preview");
		const preview = factory.sessionPreview();
		const name = await preview.getSessionName(store.id);
		expect(name).toBeUndefined();
		expect(await preview.getSessionNameSource(store.id)).toBeUndefined();
	});

	it("getSessionPreview returns recent events in chronological order", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);

		const store = await SqliteSessionStore.create(client, "/tmp/preview");

		await store.append({ bus: "event", type: "llm.input", correlationId: "t1", payload: { text: "first question" }, timestamp: 1000 });
		await store.append({ bus: "command", type: "llm.response", correlationId: "t1", payload: { text: "first answer" }, timestamp: 2000 });
		await store.append({ bus: "command", type: "fs.read", correlationId: "t2", payload: { path: "/tmp" }, timestamp: 3000 });
		await store.append({ bus: "event", type: "llm.input", correlationId: "t3", payload: { text: "second question" }, timestamp: 4000 });

		const preview = await factory.sessionPreview().getSessionPreview!(store.id, 10);

		expect(preview.length).toBe(4);
		expect(preview[0]).toContain("▸");
		expect(preview[0]).toContain("first question");
		expect(preview[1]).toContain("◂");
		expect(preview[1]).toContain("first answer");
		expect(preview[2]).toContain("●");
		expect(preview[2]).toContain("fs.read");
		expect(preview[3]).toContain("▸");
		expect(preview[3]).toContain("second question");
	});

	it("getSessionPreview returns at most maxLines entries", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);

		const store = await SqliteSessionStore.create(client, "/tmp/preview");
		for (let i = 0; i < 20; i++) {
			await store.append({ bus: "event", type: "llm.input", correlationId: `t${i}`, payload: { text: `msg ${i}` }, timestamp: i * 1000 });
		}

		const preview = await factory.sessionPreview().getSessionPreview!(store.id, 5);
		expect(preview.length).toBe(5);
		expect(preview[4]).toContain("msg 19");
	});

	it("getSessionPreview returns LIFO — most recent events shown last", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);
		const factory = new SqliteStorageFactory(client);

		const store = await SqliteSessionStore.create(client, "/tmp/preview");
		await store.append({ bus: "event", type: "llm.input", correlationId: "t1", payload: { text: "old message" }, timestamp: 1000 });
		await store.append({ bus: "event", type: "llm.input", correlationId: "t2", payload: { text: "new message" }, timestamp: 2000 });

		const preview = await factory.sessionPreview().getSessionPreview!(store.id, 5);
		expect(preview[0]).toContain("old message");
		expect(preview[1]).toContain("new message");
	});
});
