import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Post, ThreadInfo, TopicSummary } from "./types.js";

interface StoredPost {
	author: string;
	content: unknown;
	timestamp: number;
}

export class ForumStore {
	private readonly root: string;

	constructor(sessionDir: string) {
		this.root = join(sessionDir, "forum");
	}

	append(topic: string, thread: string, author: string, content: unknown): Post {
		const post: Post = { topic, thread, author, content, timestamp: Date.now() };
		const path = this.threadPath(topic, thread);
		mkdirSync(join(path, ".."), { recursive: true });
		const stored: StoredPost = { author: post.author, content: post.content, timestamp: post.timestamp };
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
				const stored = JSON.parse(line) as StoredPost;
				if (since !== undefined && stored.timestamp <= since) continue;
				posts.push({ topic, thread, author: stored.author, content: stored.content, timestamp: stored.timestamp });
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
