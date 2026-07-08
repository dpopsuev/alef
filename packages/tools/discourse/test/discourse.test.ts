import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiscourseAdapter } from "../src/adapter.js";
import { DiscourseStore } from "../src/store.js";

adapterComplianceSuite(() =>
	createDiscourseAdapter({ sessionDir: mkdtempSync(join(tmpdir(), "alef-forum-compliance-")) }),
);

// ---------------------------------------------------------------------------
// DiscourseStore — unit tests (SUT: store, no I/O mocking — store IS I/O)
// ---------------------------------------------------------------------------
describe("DiscourseStore", () => {
	let sessionDir: string;
	let store: DiscourseStore;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "alef-forum-store-"));
		store = new DiscourseStore(sessionDir);
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	describe("append + readThread", () => {
		it("appends a post and reads it back", () => {
			store.append("reviews", "nesting", "alice", "too deep");
			const posts = store.readThread("reviews", "nesting");
			expect(posts).toHaveLength(1);
			expect(posts[0]).toMatchObject({
				topic: "reviews",
				thread: "nesting",
				author: "alice",
				content: "too deep",
			});
			expect(posts[0]!.timestamp).toBeGreaterThan(0);
		});

		it("appends multiple posts in order", () => {
			store.append("reviews", "nesting", "alice", "first");
			store.append("reviews", "nesting", "bob", "second");
			const posts = store.readThread("reviews", "nesting");
			expect(posts).toHaveLength(2);
			expect(posts[0]!.author).toBe("alice");
			expect(posts[1]!.author).toBe("bob");
		});

		it("stores JSON-serializable content", () => {
			store.append("data", "metrics", "agent", { score: 42, tags: ["a", "b"] });
			const posts = store.readThread("data", "metrics");
			expect(posts[0]!.content).toEqual({ score: 42, tags: ["a", "b"] });
		});

		it("returns the created post from append", () => {
			const post = store.append("t", "th", "me", "hello");
			expect(post).toMatchObject({ topic: "t", thread: "th", author: "me", content: "hello" });
		});

		it("writes JSONL to disk", () => {
			store.append("t", "th", "a", "msg");
			const path = join(sessionDir, "discourse", "t", "th.jsonl");
			const raw = readFileSync(path, "utf-8").trim();
			const parsed = JSON.parse(raw);
			expect(parsed.author).toBe("a");
			expect(parsed.content).toBe("msg");
			expect(parsed.timestamp).toBeGreaterThan(0);
		});

		it("does not store topic/thread in JSONL (derived from path)", () => {
			store.append("t", "th", "a", "msg");
			const path = join(sessionDir, "discourse", "t", "th.jsonl");
			const parsed = JSON.parse(readFileSync(path, "utf-8").trim());
			expect(parsed).not.toHaveProperty("topic");
			expect(parsed).not.toHaveProperty("thread");
		});
	});

	describe("readThread with since filter", () => {
		it("filters posts older than since", () => {
			store.append("t", "th", "a", "old");
			const cutoff = Date.now() - 1;
			const posts = store.readThread("t", "th", cutoff);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.author).toBe("a");
		});

		it("excludes posts at or before since timestamp", () => {
			const p1 = store.append("t", "th", "a", "old");
			const posts = store.readThread("t", "th", p1.timestamp);
			expect(posts).toHaveLength(0);
		});

		it("returns all when since is undefined", () => {
			store.append("t", "th", "a", "first");
			store.append("t", "th", "b", "second");
			expect(store.readThread("t", "th")).toHaveLength(2);
		});
	});

	describe("empty state", () => {
		it("returns empty array for non-existent thread", () => {
			expect(store.readThread("nope", "nada")).toEqual([]);
		});

		it("returns empty topics for fresh store", () => {
			expect(store.listTopics()).toEqual([]);
		});

		it("returns empty threads for non-existent topic", () => {
			expect(store.listThreads("nope")).toEqual([]);
		});
	});

	describe("listTopics + listThreads", () => {
		it("lists topics after posts", () => {
			store.append("alpha", "t1", "a", "x");
			store.append("beta", "t2", "b", "y");
			const topics = store.listTopics();
			expect(topics).toContain("alpha");
			expect(topics).toContain("beta");
		});

		it("lists threads within a topic", () => {
			store.append("reviews", "nesting", "a", "x");
			store.append("reviews", "naming", "b", "y");
			const threads = store.listThreads("reviews");
			expect(threads).toContain("nesting");
			expect(threads).toContain("naming");
		});
	});

	describe("threadInfo", () => {
		it("computes post count, participants, and lastActivity", () => {
			store.append("r", "t1", "alice", "a");
			store.append("r", "t1", "bob", "b");
			store.append("r", "t1", "alice", "c");
			const info = store.threadInfo("r", "t1");
			expect(info.name).toBe("t1");
			expect(info.posts).toBe(3);
			expect(info.participants).toEqual(["alice", "bob"]);
			expect(info.lastActivity).toBeGreaterThan(0);
		});

		it("handles empty thread", () => {
			const info = store.threadInfo("r", "empty");
			expect(info).toMatchObject({ posts: 0, participants: [], lastActivity: 0 });
		});
	});

	describe("topicSummaries", () => {
		it("returns all topics with thread names", () => {
			store.append("alpha", "t1", "a", "x");
			store.append("alpha", "t2", "a", "x");
			store.append("beta", "t3", "a", "x");
			const summaries = store.topicSummaries();
			const alpha = summaries.find((s) => s.topic === "alpha");
			expect(alpha).toBeDefined();
			expect(alpha!.threads).toContain("t1");
			expect(alpha!.threads).toContain("t2");
		});

		it("returns empty for fresh store", () => {
			expect(store.topicSummaries()).toEqual([]);
		});
	});

	describe("readNewPosts", () => {
		it("reads posts across all topics since a timestamp", () => {
			const cutoff = Date.now() - 1;
			store.append("a", "t1", "x", "first");
			store.append("b", "t2", "y", "second");
			const newPosts = store.readNewPosts(cutoff);
			expect(newPosts).toHaveLength(2);
		});

		it("returns empty when no new posts", () => {
			store.append("a", "t1", "x", "msg");
			expect(store.readNewPosts(Date.now() + 1000)).toEqual([]);
		});

		it("returns sorted by timestamp", () => {
			store.append("b", "t1", "y", "second");
			store.append("a", "t1", "x", "third");
			const all = store.readNewPosts(0);
			for (let i = 1; i < all.length; i++) {
				expect(all[i]!.timestamp).toBeGreaterThanOrEqual(all[i - 1]!.timestamp);
			}
		});
	});

	describe("malformed data resilience", () => {
		it("skips malformed JSONL lines", () => {
			store.append("t", "th", "a", "good");
			const path = join(sessionDir, "discourse", "t", "th.jsonl");
			const existing = readFileSync(path, "utf-8");
			writeFileSync(path, `${existing}not-json\n{"broken\n`);
			const posts = store.readThread("t", "th");
			expect(posts).toHaveLength(1);
			expect(posts[0]!.content).toBe("good");
		});
	});
});

// ---------------------------------------------------------------------------
// Adapter — structural tests
// ---------------------------------------------------------------------------
describe("organ-forum structure", () => {
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "alef-forum-organ-"));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("creates organ with correct name and tools", () => {
		const organ = createDiscourseAdapter({ sessionDir });
		expect(organ.name).toBe("discourse");
		expect(organ.tools.map((t) => t.name)).toEqual(["discourse.post", "discourse.read", "discourse.list"]);
	});

	it("declares file sources", () => {
		const organ = createDiscourseAdapter({ sessionDir });
		expect(organ.sources).toEqual([{ name: "discourse-files", kind: "file" }]);
	});

	it("has context.assemble contribution", () => {
		const organ = createDiscourseAdapter({ sessionDir });
		expect(organ.contributions?.["context.assemble"]).toBeDefined();
	});

	it("has directives", () => {
		const organ = createDiscourseAdapter({ sessionDir });
		expect(organ.directives).toBeDefined();
		expect(organ.directives!.length).toBeGreaterThan(0);
	});
});
