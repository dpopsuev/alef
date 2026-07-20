/** Scalar JSON value. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursively JSON-serializable value. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** Verified reference to an artifact owned outside the forum. */
export interface ArtifactReference {
	readonly kind: string;
	readonly id: string;
}
/** Stable forum, topic, and thread identity. */
export interface ThreadAddress {
	readonly forumId: string;
	readonly topicId: string;
	readonly threadId: string;
}
/** Immutable append-only forum post. */
export interface Post extends ThreadAddress {
	readonly id: string;
	readonly authorId: string;
	readonly content: JsonValue;
	readonly timestamp: number;
	readonly sequence: number;
	readonly operationId: string;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly replyToPostId?: string;
	readonly references: readonly ArtifactReference[];
}
/** Versioned event categories emitted by forum mutations. */
export type DiscourseEventType =
	| "post-added"
	| "thread-changed"
	| "question-opened"
	| "question-answered"
	| "subscription-resync-required";
/** Content-free event suitable for bounded subscriptions. */
export interface DiscourseEvent extends ThreadAddress {
	readonly schemaVersion: "discourse.event.v1";
	readonly type: DiscourseEventType;
	readonly sequence: number;
	readonly timestamp: number;
	readonly postId?: string;
	readonly operationId?: string;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly responseId?: string;
	readonly retainedFromSequence?: number;
}
/** Idempotent command to append one post or reply. */
export interface AppendPostCommand extends ThreadAddress {
	readonly schemaVersion: "discourse.command.v1";
	readonly operationId: string;
	readonly authorId: string;
	readonly content: JsonValue;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly replyToPostId?: string;
	readonly references?: readonly ArtifactReference[];
}
/** Committed post and duplicate-operation disposition. */
export interface AppendPostResult {
	readonly post: Post;
	readonly replayed: boolean;
}
/** Bounded query page with explicit completeness. */
export interface Page<T> {
	readonly items: readonly T[];
	readonly truncated: boolean;
	readonly nextSequence?: number;
	readonly completeness: "complete" | "truncated";
}
/** Bounded topic projection. */
export interface TopicSummary {
	readonly forumId: string;
	readonly topicId: string;
	readonly threadCount: number;
	readonly postCount: number;
	readonly lastActivity: number;
}
/** Bounded thread projection. */
export interface ThreadSummary extends ThreadAddress {
	readonly postCount: number;
	readonly participantIds: readonly string[];
	readonly lastActivity: number;
}
/** Question without a matching answer. */
export interface OpenQuestion {
	readonly responseId: string;
	readonly post: Post;
}
/** Bounded resynchronization snapshot. */
export interface Snapshot {
	readonly throughSequence: number;
	readonly posts: Page<Post>;
}
/** Durable projection input committed with its post. */
export interface ProjectionRecord {
	readonly sequence: number;
	readonly post: Post;
}
/** Observable projection checkpoint and lag state. */
export interface ProjectionStatus {
	readonly projectionId: string;
	readonly checkpoint: number;
	readonly latestSequence: number;
	readonly pending: number;
	readonly state: "current" | "lagging" | "failed";
	readonly failure?: string;
}
/** One bounded replay or live event delivery. */
export interface SubscriptionBatch {
	readonly events: readonly DiscourseEvent[];
	readonly replayed: boolean;
}
/** Lifetime handle for a live subscription. */
export interface SubscriptionHandle {
	close(): void;
}
