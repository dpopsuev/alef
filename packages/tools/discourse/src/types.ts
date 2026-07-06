/**
 *
 */
export interface Post {
	readonly topic: string;
	readonly thread: string;
	readonly author: string;
	readonly content: unknown;
	readonly timestamp: number;
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
