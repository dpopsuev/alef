/**
 *
 */
export interface PostWriteOptions {
	readonly replyToPostId?: string;
}

/**
 *
 */
export interface Post {
	readonly id: string;
	readonly topic: string;
	readonly thread: string;
	readonly author: string;
	readonly content: unknown;
	readonly timestamp: number;
	readonly replyToPostId?: string;
	readonly references?: readonly string[];
}

/**
 *
 */
export interface ThreadInfo {
	readonly name: string;
	readonly posts: number;
	readonly participants: readonly string[];
	readonly lastActivity: number;
}

/**
 *
 */
export interface TopicSummary {
	readonly topic: string;
	readonly threads: readonly string[];
}
