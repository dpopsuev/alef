/** Scalar JSON value. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursively JSON-serializable value. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** Verified reference to an artifact owned outside the forum. */
export interface ArtifactReference {
	readonly kind: string;
	readonly id: string;
}
/** Stable board identity: a communication space belonging to a project, collective, or entity. */
export interface BoardAddress {
	readonly boardId: string;
}
/** Stable forum identity: a category and access scope within a Board. */
export interface ForumAddress extends BoardAddress {
	readonly forumId: string;
}
/** Stable topic identity: one bounded subject, question, decision, or collaboration objective. */
export interface TopicAddress extends ForumAddress {
	readonly topicId: string;
}
/** Stable board, forum, topic, and thread identity. */
export interface ThreadAddress extends TopicAddress {
	readonly threadId: string;
}
/** Board lifecycle: a Board never reopens once archived. */
export type BoardState = "active" | "archived";
/** Forum lifecycle: access narrows monotonically toward archived. */
export type ForumState = "open" | "read-only" | "archived";
/** Topic lifecycle: a resolved Topic may reopen; an archived one is terminal. */
export type TopicState = "open" | "resolved" | "archived";
/** Thread lifecycle: a closed Thread may reopen; an archived one is terminal. */
export type ThreadState = "open" | "closed" | "archived";
/** Actor-to-thread participation: independent of authorship or delivery cursors. */
export type ParticipationMode = "invited" | "subscribed" | "muted" | "left";
/** One actor's participation record for one thread. */
export interface Participant {
	readonly actorId: string;
	readonly mode: ParticipationMode;
	readonly joinedAt: number;
	readonly updatedAt: number;
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
export interface TopicSummary extends TopicAddress {
	readonly state: TopicState;
	readonly threadCount: number;
	readonly postCount: number;
	readonly lastActivity: number;
}
/** Bounded thread projection. */
export interface ThreadSummary extends ThreadAddress {
	readonly state: ThreadState;
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
