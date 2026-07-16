import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscourseBackend } from "./scribe-backend.js";
import type { Post, PostWriteOptions, ThreadInfo, TopicSummary } from "./types.js";

interface StoredPost {
	id: string;
	author: string;
	content: unknown;
	timestamp: number;
	replyToPostId?: string;
	references?: readonly string[];
}

/**
 *
 */
function resolveReplyMeta(existing: readonly Post[], opts?: PostWriteOptions): Pick<Post, "replyToPostId" | "references"> {
	if (!opts?.replyToPostId) return { replyToPostId: undefined, references: [] };
	const parent = existing.find((post) => post.id === opts.replyToPostId);
	return {
		replyToPostId: opts.replyToPostId,
		references: parent ? [...(parent.references ?? []), parent.id] : [],
	};
}

/**
 *
 */
function fallbackPostId(topic: string, thread: string, stored: StoredPost): string {
	return createHash("sha1")
		.update(JSON.stringify([topic, thread, stored.author, stored.timestamp, stored.content]))
		.digest("hex")
		.slice(0, 16);
}

/**
 * Local JSONL discourse store (offline / single-session default).
 */
export class DiscourseStore implements DiscourseBackend {
	private readonly root: string;

	constructor(sessionDir: string) {
		this.root = join(sessionDir, "discourse");
	}

	append(topic: string, thread: string, author: string, content: unknown, opts?: PostWriteOptions): Post {
		const replyMeta = resolveReplyMeta(this.readThread(topic, thread), opts);
		const post: Post = {
			id: randomUUID(),
			topic,
			thread,
			author,
			content,
			timestamp: Date.now(),
			replyToPostId: replyMeta.replyToPostId,
			references: replyMeta.references,
		};
		const path = this.threadPath(topic, thread);
		mkdirSync(join(path, ".."), { recursive: true });
		const stored: StoredPost = {
			id: post.id,
			author: post.author,
			content: post.content,
			timestamp: post.timestamp,
			replyToPostId: post.replyToPostId,
			references: post.references,
		};
		appendFileSync(path, `${JSON.stringify(stored)}\n`, "utf-8");
		return post;
	}

	readThread(topic: string, thread: string, since?: number): Post[] {
		const path = this.threadPath(topic, thread);
		if (!existsSync(path)) return [];
		const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
		const posts: Post[] = [];
		for (const line of lines) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL line parsed from append-only store with known schema
				const stored = JSON.parse(line) as StoredPost;
				if (since !== undefined && stored.timestamp <= since) continue;
				posts.push({
					id: typeof stored.id === "string" ? stored.id : fallbackPostId(topic, thread, stored),
					topic,
					thread,
					author: stored.author,
					content: stored.content,
					timestamp: stored.timestamp,
					replyToPostId: stored.replyToPostId,
					references: stored.references,
				});
			} catch {
				// skip malformed lines — append-only JSONL may have partial writes on crash
			}
		}
		return posts;
	}

	listTopics(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	}

	listThreads(topic: string): string[] {
		const dir = join(this.root, topic);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.slice(0, -6));
	}

	threadInfo(topic: string, thread: string): ThreadInfo {
		const posts = this.readThread(topic, thread);
		const participants = [...new Set(posts.map((p) => p.author))];
		const lastActivity = posts.length > 0 ? Math.max(...posts.map((p) => p.timestamp)) : 0;
		return { name: thread, posts: posts.length, participants, lastActivity };
	}

	topicSummaries(): TopicSummary[] {
		return this.listTopics().map((topic) => ({ topic, threads: this.listThreads(topic) }));
	}

	readNewPosts(since: number): Post[] {
		const results: Post[] = [];
		for (const topic of this.listTopics()) {
			for (const thread of this.listThreads(topic)) {
				for (const post of this.readThread(topic, thread, since)) {
					results.push(post);
				}
			}
		}
		return results.sort((a, b) => a.timestamp - b.timestamp);
	}

	private threadPath(topic: string, thread: string): string {
		return join(this.root, topic, `${thread}.jsonl`);
	}
}
