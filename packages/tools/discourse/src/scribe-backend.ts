/**
 * Scribe mirror — dual-writes store posts into the Scribe vault when loaded.
 * Reads always come from the inner DiscourseBackend (session store).
 */
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { DiscourseBackend } from "./backend.js";
import type { Post, PostWriteOptions, ThreadInfo, TopicSummary } from "./types.js";

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

/**
 *
 */
function encodeMetaLine(meta: Pick<Post, "id" | "replyToPostId" | "references">): string {
	return `[[alef-discourse-meta ${JSON.stringify(meta)}]]`;
}

/** Serialize post body for message_add. */
function contentToText(post: Pick<Post, "id" | "content" | "replyToPostId" | "references">): string {
	const body = typeof post.content === "string" ? post.content : JSON.stringify(post.content);
	const metaLine = encodeMetaLine(post);
	return `${metaLine}\n${body}`;
}

/**
 * Dual-write mirror: write Alef store first, then best-effort mirror to Scribe.
 * When Scribe is loaded it is a live vault SoT; session SQLite prevents data loss if Scribe stops.
 */
export class ScribeDiscourseMirror implements DiscourseBackend {
	constructor(
		private readonly store: DiscourseBackend,
		private readonly call: ScribeArtifactCall,
		private readonly scope = "default",
		private readonly logger?: AdapterLogger,
	) {}

	async append(topic: string, thread: string, author: string, content: unknown, opts?: PostWriteOptions): Promise<Post> {
		const post = await this.store.append(topic, thread, author, content, opts);
		try {
			await this.mirror(post);
		} catch (error) {
			this.logger?.warn(
				{ err: error, topic, thread, postId: post.id },
				"discourse: scribe mirror failed; store write kept",
			);
		}
		return post;
	}

	readThread(topic: string, thread: string, since?: number): Post[] | Promise<Post[]> {
		return this.store.readThread(topic, thread, since);
	}

	listTopics(): string[] | Promise<string[]> {
		return this.store.listTopics();
	}

	listThreads(topic: string): string[] | Promise<string[]> {
		return this.store.listThreads(topic);
	}

	threadInfo(topic: string, thread: string): ThreadInfo | Promise<ThreadInfo> {
		return this.store.threadInfo(topic, thread);
	}

	topicSummaries(): TopicSummary[] | Promise<TopicSummary[]> {
		return this.store.topicSummaries();
	}

	readNewPosts(since: number): Post[] | Promise<Post[]> {
		return this.store.readNewPosts(since);
	}

	private async mirror(post: Post): Promise<void> {
		const tid = topicId(this.scope, post.topic);
		const thid = threadId(this.scope, post.topic, post.thread);
		await this.ensureContext(tid, `topic ${post.topic}`, ["role:channel", `topic:${post.topic}`]);
		await this.ensureContext(
			thid,
			`thread ${post.topic}/${post.thread}`,
			["role:thread", `topic:${post.topic}`, `thread:${post.thread}`],
			tid,
		);
		await this.call("message_add", {
			parent: thid,
			text: contentToText(post),
			author: post.author,
			scope: this.scope,
		});
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
