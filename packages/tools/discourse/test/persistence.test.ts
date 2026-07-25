import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { openDiscourseBackend } from "../src/open-backend.js";

describe("discourse session-store persistence", { tags: ["unit"] }, () => {
	const clients: Array<ReturnType<typeof createClient>> = [];
	const directories: string[] = [];
	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("writes posts to the capability store and not under cwd/discourse", async () => {
		const directory = mkdtempSync(join(tmpdir(), "discourse-persistence-"));
		directories.push(directory);
		const client = createClient({ url: `file:${join(directory, "session.db")}` });
		clients.push(client);
		const cwd = process.cwd();
		const backend = await openDiscourseBackend({ client, sessionId: "sess-1" });
		await backend.append("forum", "thread-a", "@alice", "hello store");
		const rows = await client.execute({
			sql: "SELECT session_id, topic_id, thread_id, author_id, content_json FROM discourse_capability_posts WHERE session_id = ?",
			args: ["sess-1"],
		});
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]).toMatchObject({
			session_id: "sess-1",
			topic_id: "forum",
			thread_id: "thread-a",
			author_id: "@alice",
		});
		expect(JSON.parse(String(rows.rows[0]?.content_json))).toBe("hello store");
		expect(existsSync(join(cwd, "discourse", "forum", "thread-a.jsonl"))).toBe(false);
	});
});
