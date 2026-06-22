import type Database from "better-sqlite3";

export interface Post {
	readonly topic: string;
	readonly thread: string;
	readonly author: string;
	readonly content: unknown;
	readonly timestamp: number;
}

export interface ThreadInfo {
	readonly name: string;
	readonly posts: number;
	readonly participants: readonly string[];
	readonly lastActivity: number;
}

export interface TopicSummary {
	readonly topic: string;
	readonly threads: readonly string[];
}

export class SqliteDiscourseStore {
	private readonly db: Database.Database;
	private readonly sessionId: string;
	private readonly insertStmt: Database.Statement;

	constructor(db: Database.Database, sessionId: string) {
		this.db = db;
		this.sessionId = sessionId;
		this.insertStmt = db.prepare(
			"INSERT INTO discourse_posts (session_id, topic, thread, author, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		);
	}

	append(topic: string, thread: string, author: string, content: unknown): Post {
		const post: Post = { topic, thread, author, content, timestamp: Date.now() };
		this.insertStmt.run(this.sessionId, topic, thread, author, JSON.stringify(content), post.timestamp);
		return post;
	}

	readThread(topic: string, thread: string, since?: number): Post[] {
		const query =
			since !== undefined
				? this.db.prepare(
						"SELECT author, content, timestamp FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? AND timestamp > ? ORDER BY rowid",
					)
				: this.db.prepare(
						"SELECT author, content, timestamp FROM discourse_posts WHERE session_id = ? AND topic = ? AND thread = ? ORDER BY rowid",
					);

		const rows = (
			since !== undefined
				? query.all(this.sessionId, topic, thread, since)
				: query.all(this.sessionId, topic, thread)
		) as Array<{
			author: string;
			content: string;
			timestamp: number;
		}>;

		return rows.map((r) => ({
			topic,
			thread,
			author: r.author,
			content: JSON.parse(r.content) as unknown,
			timestamp: r.timestamp,
		}));
	}

	listTopics(): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT topic FROM discourse_posts WHERE session_id = ?")
			.all(this.sessionId) as Array<{ topic: string }>;
		return rows.map((r) => r.topic);
	}

	listThreads(topic: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT thread FROM discourse_posts WHERE session_id = ? AND topic = ?")
			.all(this.sessionId, topic) as Array<{ thread: string }>;
		return rows.map((r) => r.thread);
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
		const rows = this.db
			.prepare(
				"SELECT topic, thread, author, content, timestamp FROM discourse_posts WHERE session_id = ? AND timestamp > ? ORDER BY timestamp",
			)
			.all(this.sessionId, since) as Array<{
			topic: string;
			thread: string;
			author: string;
			content: string;
			timestamp: number;
		}>;

		return rows.map((r) => ({
			topic: r.topic,
			thread: r.thread,
			author: r.author,
			content: JSON.parse(r.content) as unknown,
			timestamp: r.timestamp,
		}));
	}
}
