import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDiscourseStore } from "../src/memory-store.js";
import { openDiscourseBackend } from "../src/open-backend.js";
import { ScribeDiscourseMirror } from "../src/scribe-backend.js";

describe("discourse session-store persistence", { tags: ["unit"] }, () => {
	const clients: Array<ReturnType<typeof createClient>> = [];

	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
	});

	it("writes posts to discourse_posts and not under cwd/discourse", async () => {
		const client = createClient({ url: ":memory:" });
		clients.push(client);
		const cwd = process.cwd();
		const backend = await openDiscourseBackend({ client, sessionId: "sess-1" });
		await backend.append("forum", "thread-a", "@alice", "hello store");

		const rows = await client.execute({
			sql: "SELECT session_id, topic, thread, author, content FROM discourse_posts WHERE session_id = ?",
			args: ["sess-1"],
		});
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]).toMatchObject({
			session_id: "sess-1",
			topic: "forum",
			thread: "thread-a",
			author: "@alice",
		});
		expect(JSON.parse(String(rows.rows[0]!.content))).toBe("hello store");
		expect(existsSync(join(cwd, "discourse", "forum", "thread-a.jsonl"))).toBe(false);
	});

	it("keeps store write when Scribe mirror fails", async () => {
		const store = new InMemoryDiscourseStore();
		const call = vi.fn(async () => {
			throw new Error("scribe down");
		});
		const warn = vi.fn();
		const backend = new ScribeDiscourseMirror(store, call, "mesh", {
			debug: vi.fn(),
			info: vi.fn(),
			warn,
			error: vi.fn(),
			child: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() as never }),
		});

		const post = await backend.append("qa", "nesting", "alice", "kept");
		expect(post.content).toBe("kept");
		expect(store.readThread("qa", "nesting")).toHaveLength(1);
		expect(warn).toHaveBeenCalled();
	});

	it("reads from store after mirroring to Scribe", async () => {
		const store = new InMemoryDiscourseStore();
		const calls: string[] = [];
		const call = vi.fn(async (action: string) => {
			calls.push(action);
			if (action === "get") throw new Error("missing");
			return "ok";
		});
		const backend = new ScribeDiscourseMirror(store, call, "mesh");
		await backend.append("qa", "nesting", "alice", "hello");
		const posts = await backend.readThread("qa", "nesting");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.content).toBe("hello");
		expect(calls).toContain("message_add");
		expect(calls).not.toContain("message_list");
	});
});
