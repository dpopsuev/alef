import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { DiscourseBackend } from "./backend.js";
import type { Post, PostWriteOptions, ThreadInfo, TopicSummary } from "./types.js";

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
function fallbackPostId(row: Record<string, unknown>): string {
	return createHash("sha1")
		.update(
			JSON.stringify([
				typeof row.topic === "string" ? row.topic : "",
				typeof row.thread === "string" ? row.thread : "",
				typeof row.author === "string" ? row.author : "",
				Number(row.timestamp ?? 0),
				typeof row.content === "string" ? row.content : "",
			]),
		)
		.digest("hex")
		.slice(0, 16);
}

/** Parse a JSON array and keep only string elements. */
function parseStringArray(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/** Session-DB discourse store — primary Alef persistence adapter. */
export class SqliteDiscourseStore implements DiscourseBackend {
	private readonly client: Client;
	private readonly sessionId: string;

	constructor(client: Client, sessionId: string) {
		this.client = client;
		this.sessionId = sessionId;
	}

	async append(topic: string, thread: string, author: string, content: unknown, opts?: PostWriteOptions): Promise<Post> {
		const replyMeta = resolveReplyMeta(await this.readThread(topic, thread), opts);
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
		await this.client.execute({
			sql: "INSERT INTO discourse_posts (session_id, id, topic, thread, author, content, timestamp, reply_to_post_id, references_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			args: [
				this.sessionId,
				post.id,
				topic,
				thread,
				author,
				JSON.stringify(content),
				post.timestamp,
				post.replyToPostId ?? null,
				JSON.stringify(post.references ?? []),
			],
		});
		return post;
	}

	async readThread(topic: string, thread: string, since?: number): Promise<Post[]> {
		const result =
			since !== undefined
				? await this.client.execute({
						sql: "SELECT id, author, content, timestamp, reply_to_post_id, references_json FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? AND timestamp > ? ORDER BY rowid",
						args: [this.sessionId, topic, thread, since],
					})
				: await this.client.execute({
						sql: "SELECT id, author, content, timestamp, reply_to_post_id, references_json FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? ORDER BY rowid",
						args: [this.sessionId, topic, thread],
					});

		return result.rows.map((r) => ({
			id: typeof r.id === "string" ? r.id : fallbackPostId(r),
			topic,
			thread,
			author: typeof r.author === "string" ? r.author : "",
			content: JSON.parse(typeof r.content === "string" ? r.content : "null") as unknown,
			timestamp: Number(r.timestamp),
			replyToPostId: typeof r.reply_to_post_id === "string" ? r.reply_to_post_id : undefined,
			references: parseStringArray(typeof r.references_json === "string" ? r.references_json : "[]"),
		}));
	}

	async listTopics(): Promise<string[]> {
		const result = await this.client.execute({
			sql: "SELECT DISTINCT topic FROM discourse_posts WHERE session_id = ?",
			args: [this.sessionId],
		});
		return result.rows.map((r) => typeof r.topic === "string" ? r.topic : "");
	}

	async listThreads(topic: string): Promise<string[]> {
		const result = await this.client.execute({
			sql: "SELECT DISTINCT thread FROM discourse_posts WHERE session_id = ? AND topic = ?",
			args: [this.sessionId, topic],
		});
		return result.rows.map((r) => typeof r.thread === "string" ? r.thread : "");
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
			sql: "SELECT id, topic, thread, author, content, timestamp, reply_to_post_id, references_json FROM discourse_posts WHERE session_id = ? AND timestamp > ? ORDER BY timestamp",
			args: [this.sessionId, since],
		});

		return result.rows.map((r) => ({
			id: typeof r.id === "string" ? r.id : fallbackPostId(r),
			topic: typeof r.topic === "string" ? r.topic : "",
			thread: typeof r.thread === "string" ? r.thread : "",
			author: typeof r.author === "string" ? r.author : "",
			content: JSON.parse(typeof r.content === "string" ? r.content : "null") as unknown,
			timestamp: Number(r.timestamp),
			replyToPostId: typeof r.reply_to_post_id === "string" ? r.reply_to_post_id : undefined,
			references: parseStringArray(typeof r.references_json === "string" ? r.references_json : "[]"),
		}));
	}
}
