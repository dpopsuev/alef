import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAuthStore } from "../src/sqlite/auth.js";
import { SqliteDaemonRegistry } from "../src/sqlite/daemon.js";
import { applySchema } from "../src/sqlite/schema.js";
import { SqliteSessionStore } from "../src/sqlite/session.js";
import { SqliteSummaryStore } from "../src/sqlite/summary.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	await applySchema(client);
	return client;
}

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

describe("SqliteDaemonRegistry", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("register/get/unregister daemon entries", async () => {
		const client = await makeClient();
		clients.push(client);
		const daemon = new SqliteDaemonRegistry(client);

		expect(await daemon.get("abc")).toBeUndefined();

		await daemon.register({ port: 8080, host: "127.0.0.1", pid: 1234, sessionId: "abc", cwd: "/tmp", startedAt: 1000 });
		const entry = await daemon.get("abc");
		expect(entry?.port).toBe(8080);
		expect(entry?.host).toBe("127.0.0.1");
		expect(entry?.pid).toBe(1234);
		expect(entry?.sessionId).toBe("abc");

		await daemon.register({ port: 9090, host: "127.0.0.1", pid: 5678, sessionId: "def", cwd: "/tmp2", startedAt: 2000 });
		const all = await daemon.list();
		expect(all).toHaveLength(2);
		expect(all[0].sessionId).toBe("def");

		const latest = await daemon.findLatest();
		expect(latest?.sessionId).toBe("def");

		const byCwd = await daemon.findByCwd("/tmp");
		expect(byCwd?.sessionId).toBe("abc");

		await daemon.unregister("abc");
		expect(await daemon.get("abc")).toBeUndefined();
		expect(await daemon.list()).toHaveLength(1);
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
