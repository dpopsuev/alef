import { randomUUID } from "node:crypto";
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

/** In-process discourse store for tests and storage stubs without a DB client. */
export class InMemoryDiscourseStore implements DiscourseBackend {
	private readonly posts: Post[] = [];

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
		this.posts.push(post);
		return post;
	}

	readThread(topic: string, thread: string, since?: number): Post[] {
		return this.posts.filter(
			(post) => post.topic === topic && post.thread === thread && (since === undefined || post.timestamp > since),
		);
	}

	listTopics(): string[] {
		return [...new Set(this.posts.map((post) => post.topic))].sort();
	}

	listThreads(topic: string): string[] {
		return [...new Set(this.posts.filter((post) => post.topic === topic).map((post) => post.thread))].sort();
	}

	threadInfo(topic: string, thread: string): ThreadInfo {
		const posts = this.readThread(topic, thread);
		const participants = [...new Set(posts.map((post) => post.author))];
		const lastActivity = posts.length > 0 ? Math.max(...posts.map((post) => post.timestamp)) : 0;
		return { name: thread, posts: posts.length, participants, lastActivity };
	}

	topicSummaries(): TopicSummary[] {
		return this.listTopics().map((topic) => ({ topic, threads: this.listThreads(topic) }));
	}

	readNewPosts(since: number): Post[] {
		return this.posts.filter((post) => post.timestamp > since).sort((a, b) => a.timestamp - b.timestamp);
	}
}
