import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAuthStore } from "../src/auth.js";
import { SqliteDaemonStore } from "../src/daemon.js";
import { SqliteDiscourseStore } from "../src/discourse.js";
import { applySchema } from "../src/schema.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSummaryStore } from "../src/summary.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	await applySchema(client);
	return client;
}

describe("SqliteDiscourseStore", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("appends and reads a thread", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(client, session.id);

		await discourse.append("sessions", session.id, "alice", { text: "hello" });
		await discourse.append("sessions", session.id, "bob", { text: "world" });

		const posts = await discourse.readThread("sessions", session.id);
		expect(posts).toHaveLength(2);
		expect(posts[0].author).toBe("alice");
		expect((posts[0].content as { text: string }).text).toBe("hello");
	});

	it("filters by since timestamp", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(client, session.id);

		await discourse.append("t", "th", "a", "first");
		const beforeSecond = Date.now();
		await discourse.append("t", "th", "b", "second");

		const filtered = await discourse.readThread("t", "th", beforeSecond - 1);
		expect(filtered).toHaveLength(2);
	});

	it("lists topics and threads", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(client, session.id);

		await discourse.append("topic-a", "thread-1", "alice", "msg");
		await discourse.append("topic-a", "thread-2", "bob", "msg");
		await discourse.append("topic-b", "thread-3", "alice", "msg");

		expect(await discourse.listTopics()).toHaveLength(2);
		expect(await discourse.listThreads("topic-a")).toHaveLength(2);
	});

	it("threadInfo returns metadata", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(client, session.id);

		await discourse.append("t", "th", "alice", "msg");
		await discourse.append("t", "th", "bob", "msg");

		const info = await discourse.threadInfo("t", "th");
		expect(info.posts).toBe(2);
		expect(info.participants).toContain("alice");
		expect(info.participants).toContain("bob");
	});

	it("readNewPosts returns all posts after a given timestamp", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(client, session.id);

		await discourse.append("a", "1", "alice", "msg1");
		await discourse.append("b", "2", "bob", "msg2");

		const allPosts = await discourse.readNewPosts(0);
		expect(allPosts).toHaveLength(2);

		const noPosts = await discourse.readNewPosts(Date.now() + 10_000);
		expect(noPosts).toHaveLength(0);
	});
});

describe("SqliteAuthStore", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("get/set/remove API keys", async () => {
		const client = await makeClient();
		clients.push(client);
		const auth = new SqliteAuthStore(client);

		expect(await auth.get("anthropic")).toBeUndefined();

		await auth.set("anthropic", "sk-123");
		expect(await auth.get("anthropic")).toBe("sk-123");

		await auth.set("anthropic", "sk-456");
		expect(await auth.get("anthropic")).toBe("sk-456");

		await auth.remove("anthropic");
		expect(await auth.get("anthropic")).toBeUndefined();
	});

	it("lists all providers", async () => {
		const client = await makeClient();
		clients.push(client);
		const auth = new SqliteAuthStore(client);

		await auth.set("anthropic", "sk-1");
		await auth.set("openai", "sk-2");

		const providers = await auth.list();
		expect(providers).toHaveLength(2);
		expect(providers.map((p) => p.provider)).toContain("anthropic");
	});
});

describe("SqliteDaemonStore", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("set/get/clear daemon entry", async () => {
		const client = await makeClient();
		clients.push(client);
		const daemon = new SqliteDaemonStore(client);

		expect(await daemon.get()).toBeUndefined();

		await daemon.set({ port: 8080, pid: 1234, sessionId: "abc", cwd: "/tmp" });
		const entry = await daemon.get();
		expect(entry?.port).toBe(8080);
		expect(entry?.pid).toBe(1234);
		expect(entry?.sessionId).toBe("abc");

		await daemon.set({ port: 9090, pid: 5678 });
		expect((await daemon.get())?.port).toBe(9090);

		await daemon.clear();
		expect(await daemon.get()).toBeUndefined();
	});
});

describe("SqliteSummaryStore", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("writes and reads a session summary", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const summaries = new SqliteSummaryStore(client);

		await summaries.write({
			id: session.id,
			model: "claude-sonnet-4-5",
			started_at: new Date().toISOString(),
			duration_ms: 5000,
			turns: 3,
			tokens: { input: 1000, output: 500 },
			tools: [{ name: "fs.read", calls: 5 }],
			errors: 0,
		});

		const summary = await summaries.get(session.id);
		expect(summary).toBeTruthy();
		expect(summary!.model).toBe("claude-sonnet-4-5");
		expect(summary!.turns).toBe(3);
		expect(summary!.tokens.input).toBe(1000);
		expect(summary!.tools).toHaveLength(1);
	});

	it("upserts on conflict", async () => {
		const client = await makeClient();
		clients.push(client);
		const session = await SqliteSessionStore.create(client, "/tmp/cwd");
		const summaries = new SqliteSummaryStore(client);

		await summaries.write({
			id: session.id,
			model: "old",
			started_at: "",
			duration_ms: 0,
			turns: 1,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});
		await summaries.write({
			id: session.id,
			model: "new",
			started_at: "",
			duration_ms: 0,
			turns: 2,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});

		expect((await summaries.get(session.id))?.model).toBe("new");
		expect((await summaries.get(session.id))?.turns).toBe(2);
	});

	it("latest returns most recently updated session", async () => {
		const client = await makeClient();
		clients.push(client);
		const s1 = await SqliteSessionStore.create(client, "/tmp/cwd");
		const s2 = await SqliteSessionStore.create(client, "/tmp/cwd");
		await client.execute({ sql: "UPDATE sessions SET updated_at = ? WHERE id = ?", args: [1000, s1.id] });
		await client.execute({ sql: "UPDATE sessions SET updated_at = ? WHERE id = ?", args: [2000, s2.id] });

		const summaries = new SqliteSummaryStore(client);
		await summaries.write({
			id: s1.id,
			model: "m1",
			started_at: "",
			duration_ms: 0,
			turns: 0,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});
		await summaries.write({
			id: s2.id,
			model: "m2",
			started_at: "",
			duration_ms: 0,
			turns: 0,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});

		expect((await summaries.latest())?.model).toBe("m2");
	});
});
