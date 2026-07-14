/**
 * Discourse persistence backends — file JSONL (default) or Scribe vault via artifact calls.
 */
import type { Post, ThreadInfo, TopicSummary } from "./types.js";

/**
 *
 */
export interface DiscourseBackend {
	append(topic: string, thread: string, author: string, content: unknown): Post | Promise<Post>;
	readThread(topic: string, thread: string, since?: number): Post[] | Promise<Post[]>;
	listTopics(): string[] | Promise<string[]>;
	listThreads(topic: string): string[] | Promise<string[]>;
	threadInfo(topic: string, thread: string): ThreadInfo | Promise<ThreadInfo>;
	topicSummaries(): TopicSummary[] | Promise<TopicSummary[]>;
	readNewPosts(since: number): Post[] | Promise<Post[]>;
}

/** Call Scribe artifact tool: action + params → text result. */
export type ScribeArtifactCall = (
	action: string,
	params: Record<string, unknown>,
) => Promise<string>;

/** Slug a label segment for stable Scribe IDs. */
function slugPart(s: string): string {
	const out = s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return out || "x";
}

/** Stable knowledge.context id for a Discourse topic. */
function topicId(scope: string, topic: string): string {
	return `ctx-topic-${slugPart(scope)}-${slugPart(topic)}`;
}

/** Stable knowledge.context id for a Discourse thread. */
function threadId(scope: string, topic: string, thread: string): string {
	return `ctx-thread-${slugPart(scope)}-${slugPart(topic)}-${slugPart(thread)}`;
}

/** Serialize post body for message_add. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	return JSON.stringify(content);
}

/** Parse message_list / comment_list stream text into posts. */
function parseStream(text: string, topic: string, thread: string): Post[] {
	if (!text || text === "(no messages)" || text === "(no comments)") return [];
	const chunks = text.split("\n---\n").map((c) => c.trim()).filter(Boolean);
	const posts: Post[] = [];
	for (const chunk of chunks) {
		const lines = chunk.split("\n");
		const header = lines[0] ?? "";
		const parts = header.split("\t");
		const timestamp = Number(parts[1] ?? 0);
		const body = lines.slice(1).join("\n");
		let author = "agent";
		let content: unknown = body;
		const at = /^@([^:]+):\s([\s\S]*)$/.exec(body);
		if (at) {
			author = at[1] ?? author;
			content = at[2] ?? body;
			try {
				content = JSON.parse(String(content));
			} catch {
				/* plain text */
			}
		} else {
			try {
				content = JSON.parse(body);
			} catch {
				/* plain text */
			}
		}
		posts.push({ topic, thread, author, content, timestamp });
	}
	return posts;
}

/**
 * Maps Discourse topic/thread onto Scribe message primitives (app vocabulary).
 */
export class ScribeDiscourseBackend implements DiscourseBackend {
	constructor(
		private readonly call: ScribeArtifactCall,
		private readonly scope = "default",
	) {}

	async append(topic: string, thread: string, author: string, content: unknown): Promise<Post> {
		const tid = topicId(this.scope, topic);
		const thid = threadId(this.scope, topic, thread);
		await this.ensureContext(tid, `topic ${topic}`, ["role:channel", `topic:${topic}`]);
		await this.ensureContext(thid, `thread ${topic}/${thread}`, ["role:thread", `topic:${topic}`, `thread:${thread}`], tid);
		const text = contentToText(content);
		await this.call("message_add", {
			parent: thid,
			text,
			author,
			scope: this.scope,
		});
		return { topic, thread, author, content, timestamp: Date.now() };
	}

	async readThread(topic: string, thread: string, since?: number): Promise<Post[]> {
		const thid = threadId(this.scope, topic, thread);
		const params: Record<string, unknown> = { id: thid, mode: "children" };
		if (since !== undefined) params.since = since;
		try {
			const text = await this.call("message_list", params);
			return parseStream(text, topic, thread);
		} catch {
			return [];
		}
	}

	async listTopics(): Promise<string[]> {
		const text = await this.call("query", {
			kind: "knowledge.context",
			labels: ["role:channel"],
			scope: this.scope,
			limit: 200,
			format: "summary",
		});
		return extractLabelValues(text, "topic:");
	}

	async listThreads(topic: string): Promise<string[]> {
		const text = await this.call("query", {
			kind: "knowledge.context",
			labels: ["role:thread", `topic:${topic}`],
			scope: this.scope,
			limit: 200,
			format: "summary",
		});
		return extractLabelValues(text, "thread:");
	}

	async threadInfo(topic: string, thread: string): Promise<ThreadInfo> {
		const posts = await this.readThread(topic, thread);
		const participants = [...new Set(posts.map((p) => p.author))];
		const lastActivity = posts.length > 0 ? Math.max(...posts.map((p) => p.timestamp)) : 0;
		return { name: thread, posts: posts.length, participants, lastActivity };
	}

	async topicSummaries(): Promise<TopicSummary[]> {
		const topics = await this.listTopics();
		const out: TopicSummary[] = [];
		for (const topic of topics) {
			out.push({ topic, threads: await this.listThreads(topic) });
		}
		return out;
	}

	async readNewPosts(since: number): Promise<Post[]> {
		const results: Post[] = [];
		for (const topic of await this.listTopics()) {
			for (const thread of await this.listThreads(topic)) {
				for (const post of await this.readThread(topic, thread, since)) {
					results.push(post);
				}
			}
		}
		return results.sort((a, b) => a.timestamp - b.timestamp);
	}

	private async ensureContext(
		id: string,
		title: string,
		extraLabels: string[],
		parent?: string,
	): Promise<void> {
		try {
			await this.call("get", { id });
			return;
		} catch {
			/* create */
		}
		const labels = ["kind:knowledge.context", ...extraLabels];
		if (this.scope) labels.push(`project:${this.scope}`);
		const payload: Record<string, unknown> = {
			id,
			title,
			kind: "knowledge.context",
			scope: this.scope,
			labels,
			sections: [{ name: "content", text: title }],
		};
		if (parent) payload.parent = parent;
		try {
			await this.call("create", payload);
		} catch {
			/* race: already created */
		}
	}
}

/** Pull unique label values with a given prefix from a summary listing. */
function extractLabelValues(summaryText: string, prefix: string): string[] {
	const found = new Set<string>();
	const re = new RegExp(`${prefix}([\\w.-]+)`, "g");
	for (const match of summaryText.matchAll(re)) {
		found.add(match[1] ?? "");
	}
	return [...found].filter(Boolean).sort();
}
