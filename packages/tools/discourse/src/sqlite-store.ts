import type { Client } from "@libsql/client";
import type { Post, ThreadInfo, TopicSummary } from "./types.js";

export class SqliteDiscourseStore {
	private readonly client: Client;
	private readonly sessionId: string;

	constructor(client: Client, sessionId: string) {
		this.client = client;
		this.sessionId = sessionId;
	}

	async append(topic: string, thread: string, author: string, content: unknown): Promise<Post> {
		const post: Post = { topic, thread, author, content, timestamp: Date.now() };
		await this.client.execute({
			sql: "INSERT INTO discourse_posts (session_id, topic, thread, author, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
			args: [this.sessionId, topic, thread, author, JSON.stringify(content), post.timestamp],
		});
		return post;
	}

	async readThread(topic: string, thread: string, since?: number): Promise<Post[]> {
		const result =
			since !== undefined
				? await this.client.execute({
						sql: "SELECT author, content, timestamp FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? AND timestamp > ? ORDER BY rowid",
						args: [this.sessionId, topic, thread, since],
					})
				: await this.client.execute({
						sql: "SELECT author, content, timestamp FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? ORDER BY rowid",
						args: [this.sessionId, topic, thread],
					});

		return result.rows.map((r) => ({
			topic,
			thread,
			author: String(r.author),
			content: JSON.parse(String(r.content)) as unknown,
			timestamp: Number(r.timestamp),
		}));
	}

	async listTopics(): Promise<string[]> {
		const result = await this.client.execute({
			sql: "SELECT DISTINCT topic FROM discourse_posts WHERE session_id = ?",
			args: [this.sessionId],
		});
		return result.rows.map((r) => String(r.topic));
	}

	async listThreads(topic: string): Promise<string[]> {
		const result = await this.client.execute({
			sql: "SELECT DISTINCT thread FROM discourse_posts WHERE session_id = ? AND topic = ?",
			args: [this.sessionId, topic],
		});
		return result.rows.map((r) => String(r.thread));
	}

	async threadInfo(topic: string, thread: string): Promise<ThreadInfo> {
		const posts = await this.readThread(topic, thread);
		const participants = [...new Set(posts.map((p) => p.author))];
		const lastActivity = posts.length > 0 ? Math.max(...posts.map((p) => p.timestamp)) : 0;
		return { name: thread, posts: posts.length, participants, lastActivity };
	}

	async topicSummaries(): Promise<TopicSummary[]> {
		const topics = await this.listTopics();
		const summaries: TopicSummary[] = [];
		for (const topic of topics) {
			const threads = await this.listThreads(topic);
			summaries.push({ topic, threads });
		}
		return summaries;
	}

	async readNewPosts(since: number): Promise<Post[]> {
		const result = await this.client.execute({
			sql: "SELECT topic, thread, author, content, timestamp FROM discourse_posts WHERE session_id = ? AND timestamp > ? ORDER BY timestamp",
			args: [this.sessionId, since],
		});

		return result.rows.map((r) => ({
			topic: String(r.topic),
			thread: String(r.thread),
			author: String(r.author),
			content: JSON.parse(String(r.content)) as unknown,
			timestamp: Number(r.timestamp),
		}));
	}
}
