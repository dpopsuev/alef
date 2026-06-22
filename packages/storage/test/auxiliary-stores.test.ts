import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteAuthStore } from "../src/auth.js";
import { SqliteDaemonStore } from "../src/daemon.js";
import { SqliteDiscourseStore } from "../src/discourse.js";
import { applySchema } from "../src/schema.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSummaryStore } from "../src/summary.js";

function makeDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	applySchema(db);
	return db;
}

describe("SqliteDiscourseStore", { tags: ["unit"] }, () => {
	it("appends and reads a thread", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(db, session.id);

		discourse.append("sessions", session.id, "alice", { text: "hello" });
		discourse.append("sessions", session.id, "bob", { text: "world" });

		const posts = discourse.readThread("sessions", session.id);
		expect(posts).toHaveLength(2);
		expect(posts[0].author).toBe("alice");
		expect((posts[0].content as { text: string }).text).toBe("hello");
		db.close();
	});

	it("filters by since timestamp", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(db, session.id);

		discourse.append("t", "th", "a", "first");
		const beforeSecond = Date.now();
		discourse.append("t", "th", "b", "second");

		const filtered = discourse.readThread("t", "th", beforeSecond - 1);
		expect(filtered).toHaveLength(2);
		db.close();
	});

	it("lists topics and threads", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(db, session.id);

		discourse.append("topic-a", "thread-1", "alice", "msg");
		discourse.append("topic-a", "thread-2", "bob", "msg");
		discourse.append("topic-b", "thread-3", "alice", "msg");

		expect(discourse.listTopics()).toHaveLength(2);
		expect(discourse.listThreads("topic-a")).toHaveLength(2);
		db.close();
	});

	it("threadInfo returns metadata", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(db, session.id);

		discourse.append("t", "th", "alice", "msg");
		discourse.append("t", "th", "bob", "msg");

		const info = discourse.threadInfo("t", "th");
		expect(info.posts).toBe(2);
		expect(info.participants).toContain("alice");
		expect(info.participants).toContain("bob");
		db.close();
	});

	it("readNewPosts returns all posts after a given timestamp", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const discourse = new SqliteDiscourseStore(db, session.id);

		discourse.append("a", "1", "alice", "msg1");
		discourse.append("b", "2", "bob", "msg2");

		const allPosts = discourse.readNewPosts(0);
		expect(allPosts).toHaveLength(2);

		const noPosts = discourse.readNewPosts(Date.now() + 10_000);
		expect(noPosts).toHaveLength(0);
		db.close();
	});
});

describe("SqliteAuthStore", { tags: ["unit"] }, () => {
	it("get/set/remove API keys", () => {
		const db = makeDb();
		const auth = new SqliteAuthStore(db);

		expect(auth.get("anthropic")).toBeUndefined();

		auth.set("anthropic", "sk-123");
		expect(auth.get("anthropic")).toBe("sk-123");

		auth.set("anthropic", "sk-456");
		expect(auth.get("anthropic")).toBe("sk-456");

		auth.remove("anthropic");
		expect(auth.get("anthropic")).toBeUndefined();
		db.close();
	});

	it("lists all providers", () => {
		const db = makeDb();
		const auth = new SqliteAuthStore(db);

		auth.set("anthropic", "sk-1");
		auth.set("openai", "sk-2");

		const providers = auth.list();
		expect(providers).toHaveLength(2);
		expect(providers.map((p) => p.provider)).toContain("anthropic");
		db.close();
	});
});

describe("SqliteDaemonStore", { tags: ["unit"] }, () => {
	it("set/get/clear daemon entry", () => {
		const db = makeDb();
		const daemon = new SqliteDaemonStore(db);

		expect(daemon.get()).toBeUndefined();

		daemon.set({ port: 8080, pid: 1234, sessionId: "abc", cwd: "/tmp" });
		const entry = daemon.get();
		expect(entry?.port).toBe(8080);
		expect(entry?.pid).toBe(1234);
		expect(entry?.sessionId).toBe("abc");

		daemon.set({ port: 9090, pid: 5678 });
		expect(daemon.get()?.port).toBe(9090);

		daemon.clear();
		expect(daemon.get()).toBeUndefined();
		db.close();
	});
});

describe("SqliteSummaryStore", { tags: ["unit"] }, () => {
	it("writes and reads a session summary", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const summaries = new SqliteSummaryStore(db);

		summaries.write({
			id: session.id,
			model: "claude-sonnet-4-5",
			started_at: new Date().toISOString(),
			duration_ms: 5000,
			turns: 3,
			tokens: { input: 1000, output: 500 },
			tools: [{ name: "fs.read", calls: 5 }],
			errors: 0,
		});

		const summary = summaries.get(session.id);
		expect(summary).toBeTruthy();
		expect(summary!.model).toBe("claude-sonnet-4-5");
		expect(summary!.turns).toBe(3);
		expect(summary!.tokens.input).toBe(1000);
		expect(summary!.tools).toHaveLength(1);
		db.close();
	});

	it("upserts on conflict", () => {
		const db = makeDb();
		const session = SqliteSessionStore.create(db, "/tmp/cwd");
		const summaries = new SqliteSummaryStore(db);

		summaries.write({
			id: session.id,
			model: "old",
			started_at: "",
			duration_ms: 0,
			turns: 1,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});
		summaries.write({
			id: session.id,
			model: "new",
			started_at: "",
			duration_ms: 0,
			turns: 2,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});

		expect(summaries.get(session.id)?.model).toBe("new");
		expect(summaries.get(session.id)?.turns).toBe(2);
		db.close();
	});

	it("latest returns most recently updated session", () => {
		const db = makeDb();
		const s1 = SqliteSessionStore.create(db, "/tmp/cwd");
		const s2 = SqliteSessionStore.create(db, "/tmp/cwd");
		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(1000, s1.id);
		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(2000, s2.id);

		const summaries = new SqliteSummaryStore(db);
		summaries.write({
			id: s1.id,
			model: "m1",
			started_at: "",
			duration_ms: 0,
			turns: 0,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});
		summaries.write({
			id: s2.id,
			model: "m2",
			started_at: "",
			duration_ms: 0,
			turns: 0,
			tokens: { input: 0, output: 0 },
			tools: [],
			errors: 0,
		});

		expect(summaries.latest()?.model).toBe("m2");
		db.close();
	});
});
