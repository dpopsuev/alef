import type { Post, PostWriteOptions, ThreadInfo, TopicSummary } from "./types.js";

/** Port for discourse persistence — session store is the source of truth. */
export interface DiscourseBackend {
	append(topic: string, thread: string, author: string, content: unknown, opts?: PostWriteOptions): Post | Promise<Post>;
	readThread(topic: string, thread: string, since?: number): Post[] | Promise<Post[]>;
	listTopics(): string[] | Promise<string[]>;
	listThreads(topic: string): string[] | Promise<string[]>;
	threadInfo(topic: string, thread: string): ThreadInfo | Promise<ThreadInfo>;
	topicSummaries(): TopicSummary[] | Promise<TopicSummary[]>;
	readNewPosts(since: number): Post[] | Promise<Post[]>;
}
