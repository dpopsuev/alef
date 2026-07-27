import type {
	AppendPostCommand,
	AppendPostResult,
	ArtifactReference,
	BoardAddress,
	BoardState,
	DiscourseEvent,
	ForumAddress,
	ForumState,
	OpenQuestion,
	Page,
	Participant,
	ParticipationMode,
	Post,
	ProjectionRecord,
	SubscriptionBatch,
	SubscriptionHandle,
	ThreadAddress,
	ThreadState,
	ThreadSummary,
	TopicAddress,
	TopicState,
	TopicSummary,
} from "./types.js";

/** Bounded thread read parameters. */
export interface ReadThreadQuery extends ThreadAddress {
	readonly afterSequence?: number;
	readonly limit: number;
}
/** Bounded topic listing parameters. */
export interface ListTopicsQuery extends ForumAddress {
	readonly limit: number;
}
/** Bounded thread listing parameters. */
export interface ListThreadsQuery extends TopicAddress {
	readonly limit: number;
}
/** Bounded open-question query parameters. */
export interface OpenQuestionsQuery {
	readonly forumId?: string;
	readonly targetId?: string;
	readonly limit: number;
}
/** Bounded resynchronization query parameters. */
export interface SnapshotQuery {
	readonly forumId?: string;
	readonly afterSequence?: number;
	readonly limit: number;
}
/** Retained event replay and completeness metadata. */
export interface EventReplay {
	readonly events: readonly DiscourseEvent[];
	readonly retainedFromSequence: number;
	readonly latestSequence: number;
	readonly expired: boolean;
	readonly truncated: boolean;
}
/** Atomic store append result including committed events. */
export interface StoredAppendResult extends AppendPostResult {
	readonly events: readonly DiscourseEvent[];
}
/** Persistence port for forum state, cursors, events, and outbox records. */
export interface DiscourseStore {
	append(command: AppendPostCommand, postId: string, timestamp: number): Promise<StoredAppendResult>;
	readThread(query: ReadThreadQuery): Promise<Page<Post>>;
	listTopics(query: ListTopicsQuery): Promise<Page<TopicSummary>>;
	listThreads(query: ListThreadsQuery): Promise<Page<ThreadSummary>>;
	findOpenQuestions(query: OpenQuestionsQuery): Promise<Page<OpenQuestion>>;
	replay(afterSequence: number, limit: number): Promise<EventReplay>;
	snapshot(query: SnapshotQuery): Promise<{ posts: Page<Post>; throughSequence: number }>;
	acknowledge(consumerId: string, sequence: number): Promise<number>;
	consumerCursor(consumerId: string): Promise<number>;
	readProjectionOutbox(projectionId: string, limit: number): Promise<readonly ProjectionRecord[]>;
	acknowledgeProjection(projectionId: string, sequence: number): Promise<void>;
	projectionCheckpoint(projectionId: string): Promise<number>;
	projectionPending(projectionId: string): Promise<number>;
	latestPostSequence(): Promise<number>;
	getBoardState(address: BoardAddress): Promise<BoardState>;
	setBoardState(address: BoardAddress, state: BoardState, timestamp: number): Promise<void>;
	getForumState(address: ForumAddress): Promise<ForumState>;
	setForumState(address: ForumAddress, state: ForumState, timestamp: number): Promise<void>;
	getTopicState(address: TopicAddress): Promise<TopicState>;
	setTopicState(address: TopicAddress, state: TopicState, timestamp: number): Promise<void>;
	getThreadState(address: ThreadAddress): Promise<ThreadState>;
	setThreadState(address: ThreadAddress, state: ThreadState, timestamp: number): Promise<void>;
	setParticipation(
		address: ThreadAddress,
		actorId: string,
		mode: ParticipationMode,
		timestamp: number,
	): Promise<Participant>;
	getParticipant(address: ThreadAddress, actorId: string): Promise<Participant | undefined>;
	listParticipants(address: ThreadAddress, limit: number): Promise<readonly Participant[]>;
}
/** Push-delivery port for committed events. */
export interface DiscourseSubscription {
	publish(events: readonly DiscourseEvent[]): void;
	subscribe(afterSequence: number, listener: (batch: SubscriptionBatch) => void): SubscriptionHandle;
}
/** Trust-boundary port for artifact identity verification. */
export interface ArtifactReferenceVerifier {
	verify(reference: ArtifactReference): Promise<boolean>;
}
/** Optional idempotent external view of committed posts. */
export interface DiscourseProjection {
	readonly id: string;
	project(record: ProjectionRecord): Promise<void>;
}
