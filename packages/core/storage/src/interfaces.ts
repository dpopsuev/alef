import type { DaemonEntry } from "./daemon.js";
import type { Post, ThreadInfo, TopicSummary } from "./discourse.js";
import type { SessionSummary } from "./summary.js";

export interface DaemonStore {
	register(entry: DaemonEntry): Promise<void>;
	unregister(sessionId: string): Promise<void>;
	get(sessionId: string): Promise<DaemonEntry | undefined>;
	list(): Promise<DaemonEntry[]>;
	findByCwd(cwd: string): Promise<DaemonEntry | undefined>;
	findLatest(): Promise<DaemonEntry | undefined>;
	prune(): Promise<number>;
}

export interface DiscourseStore {
	append(topic: string, thread: string, author: string, content: unknown): Promise<Post>;
	readThread(topic: string, thread: string, since?: number): Promise<Post[]>;
	listTopics(): Promise<string[]>;
	listThreads(topic: string): Promise<string[]>;
	threadInfo(topic: string, thread: string): Promise<ThreadInfo>;
	topicSummaries(): Promise<TopicSummary[]>;
	readNewPosts(since: number): Promise<Post[]>;
}

export interface SummaryStore {
	write(summary: SessionSummary): Promise<void>;
	get(sessionId: string): Promise<SessionSummary | undefined>;
	latest(): Promise<SessionSummary | undefined>;
}

export interface AuthStore {
	get(provider: string): Promise<string | undefined>;
	set(provider: string, key: string): Promise<void>;
	remove(provider: string): Promise<void>;
	list(): Promise<Array<{ provider: string; type: string }>>;
}
