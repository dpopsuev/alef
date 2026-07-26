import { EVENT_RETENTION_DEFAULT, POST_CAPACITY_DEFAULT } from "./constants.js";
import type {
	DiscourseStore,
	DiscourseSubscription,
	EventReplay,
	ListThreadsQuery,
	ListTopicsQuery,
	OpenQuestionsQuery,
	ReadThreadQuery,
	SnapshotQuery,
	StoredAppendResult,
} from "./ports.js";
import type {
	AppendPostCommand,
	BoardAddress,
	BoardState,
	DiscourseEvent,
	DiscourseEventType,
	ForumAddress,
	ForumState,
	JsonValue,
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

/** Explicit bounds for the standalone in-memory adapter. */
export interface InMemoryDiscourseStoreOptions {
	readonly eventRetention?: number;
	readonly postCapacity?: number;
}
/** Stored idempotency input and committed result. */
interface OperationRecord {
	readonly serializedCommand: string;
	readonly result: StoredAppendResult;
}
/** Question marker carried by structured post content. */
interface QuestionMetadata {
	readonly type: "question" | "answer";
	readonly responseId: string;
	readonly targetId?: string;
}
/** Mutable push cursor for one listener. */
interface Subscriber {
	afterSequence: number;
	readonly listener: (batch: SubscriptionBatch) => void;
}

/** Build one explicit completeness page. */
function page<T>(items: readonly T[], limit: number, sequenceOf?: (item: T) => number): Page<T> {
	const truncated = items.length > limit;
	const selected = items.slice(0, limit);
	const last = selected.at(-1);
	return {
		items: selected,
		truncated,
		completeness: truncated ? "truncated" : "complete",
		...(truncated && last !== undefined && sequenceOf ? { nextSequence: sequenceOf(last) } : {}),
	};
}
/** Narrow a recursive JSON value to an object. */
function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read the structured question protocol without parsing display text. */
function questionMetadata(content: JsonValue): QuestionMetadata | undefined {
	if (!isJsonObject(content)) return undefined;
	const type = content.type;
	const responseId = content.responseId;
	const targetId = content.targetId;
	if ((type !== "question" && type !== "answer") || typeof responseId !== "string") return undefined;
	return { type, responseId, ...(typeof targetId === "string" ? { targetId } : {}) };
}
/** Compare an existing post with one thread identity. */
function sameAddress(left: Post, right: ThreadAddress): boolean {
	return (
		left.boardId === right.boardId &&
		left.forumId === right.forumId &&
		left.topicId === right.topicId &&
		left.threadId === right.threadId
	);
}
/** Stable map key for one board address. */
function boardKey(address: BoardAddress): string {
	return address.boardId;
}
/** Stable map key for one forum address. */
function forumKey(address: ForumAddress): string {
	return `${address.boardId}/${address.forumId}`;
}
/** Stable map key for one topic address. */
function topicKey(address: TopicAddress): string {
	return `${address.boardId}/${address.forumId}/${address.topicId}`;
}
/** Stable map key for one thread address. */
function threadKey(address: ThreadAddress): string {
	return `${address.boardId}/${address.forumId}/${address.topicId}/${address.threadId}`;
}

/** Bounded standalone store and reference implementation for persistence adapters. */
export class InMemoryDiscourseStore implements DiscourseStore {
	private readonly posts: Post[] = [];
	private readonly events: DiscourseEvent[] = [];
	private readonly operations = new Map<string, OperationRecord>();
	private readonly consumerCursors = new Map<string, number>();
	private readonly projectionCursors = new Map<string, number>();
	private readonly eventRetention: number;
	private readonly postCapacity: number;
	private nextSequence = 1;
	private readonly boardStates = new Map<string, BoardState>();
	private readonly forumStates = new Map<string, ForumState>();
	private readonly topicStates = new Map<string, TopicState>();
	private readonly threadStates = new Map<string, ThreadState>();
	private readonly participants = new Map<string, Map<string, Participant>>();

	constructor(options: InMemoryDiscourseStoreOptions = {}) {
		this.eventRetention = options.eventRetention ?? EVENT_RETENTION_DEFAULT;
		this.postCapacity = options.postCapacity ?? POST_CAPACITY_DEFAULT;
		if (!Number.isInteger(this.eventRetention) || this.eventRetention < 1)
			throw new Error("eventRetention must be positive");
		if (!Number.isInteger(this.postCapacity) || this.postCapacity < 1)
			throw new Error("postCapacity must be positive");
	}

	append(command: AppendPostCommand, postId: string, timestamp: number): Promise<StoredAppendResult> {
		const serializedCommand = JSON.stringify(command);
		const prior = this.operations.get(command.operationId);
		if (prior) {
			if (prior.serializedCommand !== serializedCommand)
				throw new Error(`operation conflict: ${command.operationId}`);
			return Promise.resolve({ post: prior.result.post, replayed: true, events: [] });
		}
		if (this.posts.length >= this.postCapacity) throw new Error("post capacity reached");
		const threadState = this.threadStates.get(threadKey(command)) ?? "open";
		if (threadState !== "open") throw new Error(`thread is ${threadState}: cannot post`);
		if (command.replyToPostId) {
			const parent = this.posts.find((post) => post.id === command.replyToPostId);
			if (!parent) throw new Error(`reply target not found: ${command.replyToPostId}`);
			if (!sameAddress(parent, command)) throw new Error("reply target must belong to the same thread");
		}
		const sequence = this.nextSequence;
		const post: Post = {
			id: postId,
			boardId: command.boardId,
			forumId: command.forumId,
			topicId: command.topicId,
			threadId: command.threadId,
			authorId: command.authorId,
			content: command.content,
			timestamp,
			sequence,
			operationId: command.operationId,
			...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
			...(command.causationId === undefined ? {} : { causationId: command.causationId }),
			...(command.replyToPostId === undefined ? {} : { replyToPostId: command.replyToPostId }),
			references: [...(command.references ?? [])],
		};
		const eventTypes: Array<{ type: DiscourseEventType; responseId?: string }> = [
			{ type: "post-added" },
			{ type: "thread-changed" },
		];
		const question = questionMetadata(command.content);
		if (question)
			eventTypes.push({
				type: question.type === "question" ? "question-opened" : "question-answered",
				responseId: question.responseId,
			});
		const createdEvents = eventTypes.map(
			(metadata, index): DiscourseEvent => ({
				schemaVersion: "discourse.event.v1",
				type: metadata.type,
				sequence: sequence + index,
				timestamp,
				boardId: command.boardId,
				forumId: command.forumId,
				topicId: command.topicId,
				threadId: command.threadId,
				postId,
				operationId: command.operationId,
				...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
				...(command.causationId === undefined ? {} : { causationId: command.causationId }),
				...(metadata.responseId === undefined ? {} : { responseId: metadata.responseId }),
			}),
		);
		this.nextSequence += createdEvents.length;
		this.posts.push(post);
		this.events.push(...createdEvents);
		if (this.events.length > this.eventRetention) this.events.splice(0, this.events.length - this.eventRetention);
		const result: StoredAppendResult = { post, replayed: false, events: createdEvents };
		this.operations.set(command.operationId, { serializedCommand, result });
		return Promise.resolve(result);
	}

	readThread(query: ReadThreadQuery): Promise<Page<Post>> {
		const selected = this.posts
			.filter((post) => sameAddress(post, query) && post.sequence > (query.afterSequence ?? 0))
			.sort((left, right) => left.sequence - right.sequence);
		return Promise.resolve(page(selected, query.limit, (post) => post.sequence));
	}

	listTopics(query: ListTopicsQuery): Promise<Page<TopicSummary>> {
		const grouped = new Map<string, Post[]>();
		for (const post of this.posts.filter(
			(entry) => entry.boardId === query.boardId && entry.forumId === query.forumId,
		)) {
			const posts = grouped.get(post.topicId) ?? [];
			posts.push(post);
			grouped.set(post.topicId, posts);
		}
		const summaries = [...grouped.entries()]
			.map(
				([topicId, posts]): TopicSummary => ({
					boardId: query.boardId,
					forumId: query.forumId,
					topicId,
					state:
						this.topicStates.get(topicKey({ boardId: query.boardId, forumId: query.forumId, topicId })) ?? "open",
					threadCount: new Set(posts.map((post) => post.threadId)).size,
					postCount: posts.length,
					lastActivity: Math.max(...posts.map((post) => post.timestamp)),
				}),
			)
			.sort((left, right) => left.topicId.localeCompare(right.topicId));
		return Promise.resolve(page(summaries, query.limit));
	}

	listThreads(query: ListThreadsQuery): Promise<Page<ThreadSummary>> {
		const grouped = new Map<string, Post[]>();
		for (const post of this.posts.filter(
			(entry) =>
				entry.boardId === query.boardId && entry.forumId === query.forumId && entry.topicId === query.topicId,
		)) {
			const posts = grouped.get(post.threadId) ?? [];
			posts.push(post);
			grouped.set(post.threadId, posts);
		}
		const summaries = [...grouped.entries()]
			.map(
				([threadId, posts]): ThreadSummary => ({
					boardId: query.boardId,
					forumId: query.forumId,
					topicId: query.topicId,
					threadId,
					state:
						this.threadStates.get(
							threadKey({ boardId: query.boardId, forumId: query.forumId, topicId: query.topicId, threadId }),
						) ?? "open",
					postCount: posts.length,
					participantIds: [...new Set(posts.map((post) => post.authorId))],
					lastActivity: Math.max(...posts.map((post) => post.timestamp)),
				}),
			)
			.sort((left, right) => left.threadId.localeCompare(right.threadId));
		return Promise.resolve(page(summaries, query.limit));
	}

	findOpenQuestions(query: OpenQuestionsQuery): Promise<Page<OpenQuestion>> {
		const answered = new Set(
			this.posts.flatMap((post) => {
				const metadata = questionMetadata(post.content);
				return metadata?.type === "answer" ? [metadata.responseId] : [];
			}),
		);
		const questions = this.posts.flatMap((post): OpenQuestion[] => {
			const metadata = questionMetadata(post.content);
			if (metadata?.type !== "question" || answered.has(metadata.responseId)) return [];
			if (query.forumId !== undefined && post.forumId !== query.forumId) return [];
			if (query.targetId !== undefined && metadata.targetId !== undefined && metadata.targetId !== query.targetId)
				return [];
			return [{ responseId: metadata.responseId, post }];
		});
		return Promise.resolve(page(questions, query.limit, (question) => question.post.sequence));
	}

	replay(afterSequence: number, limit: number): Promise<EventReplay> {
		const latestSequence = this.nextSequence - 1;
		const retainedFromSequence = this.events[0]?.sequence ?? this.nextSequence;
		const expired = afterSequence > 0 && afterSequence < retainedFromSequence - 1;
		const available = expired ? [] : this.events.filter((event) => event.sequence > afterSequence);
		return Promise.resolve({
			events: available.slice(0, limit),
			retainedFromSequence,
			latestSequence,
			expired,
			truncated: available.length > limit,
		});
	}

	snapshot(query: SnapshotQuery): Promise<{ posts: Page<Post>; throughSequence: number }> {
		const selected = this.posts.filter(
			(post) =>
				post.sequence > (query.afterSequence ?? 0) &&
				(query.forumId === undefined || post.forumId === query.forumId),
		);
		return Promise.resolve({
			posts: page(selected, query.limit, (post) => post.sequence),
			throughSequence: this.nextSequence - 1,
		});
	}

	acknowledge(consumerId: string, sequence: number): Promise<number> {
		if (sequence > this.nextSequence - 1) throw new Error(`cannot acknowledge future sequence ${sequence}`);
		const next = Math.max(this.consumerCursors.get(consumerId) ?? 0, sequence);
		this.consumerCursors.set(consumerId, next);
		return Promise.resolve(next);
	}

	consumerCursor(consumerId: string): Promise<number> {
		return Promise.resolve(this.consumerCursors.get(consumerId) ?? 0);
	}

	readProjectionOutbox(projectionId: string, limit: number): Promise<readonly ProjectionRecord[]> {
		const checkpoint = this.projectionCursors.get(projectionId) ?? 0;
		return Promise.resolve(
			this.posts
				.filter((post) => post.sequence > checkpoint)
				.slice(0, limit)
				.map((post) => ({ sequence: post.sequence, post })),
		);
	}

	acknowledgeProjection(projectionId: string, sequence: number): Promise<void> {
		const current = this.projectionCursors.get(projectionId) ?? 0;
		if (sequence >= current) {
			if (!this.posts.some((post) => post.sequence === sequence))
				throw new Error(`projection sequence not found: ${sequence}`);
			this.projectionCursors.set(projectionId, sequence);
		}
		return Promise.resolve();
	}

	projectionCheckpoint(projectionId: string): Promise<number> {
		return Promise.resolve(this.projectionCursors.get(projectionId) ?? 0);
	}
	projectionPending(projectionId: string): Promise<number> {
		const checkpoint = this.projectionCursors.get(projectionId) ?? 0;
		return Promise.resolve(this.posts.filter((post) => post.sequence > checkpoint).length);
	}
	latestPostSequence(): Promise<number> {
		return Promise.resolve(this.posts.at(-1)?.sequence ?? 0);
	}

	getBoardState(address: BoardAddress): Promise<BoardState> {
		return Promise.resolve(this.boardStates.get(boardKey(address)) ?? "active");
	}
	setBoardState(address: BoardAddress, state: BoardState): Promise<void> {
		this.boardStates.set(boardKey(address), state);
		return Promise.resolve();
	}
	getForumState(address: ForumAddress): Promise<ForumState> {
		return Promise.resolve(this.forumStates.get(forumKey(address)) ?? "open");
	}
	setForumState(address: ForumAddress, state: ForumState): Promise<void> {
		this.forumStates.set(forumKey(address), state);
		return Promise.resolve();
	}
	getTopicState(address: TopicAddress): Promise<TopicState> {
		return Promise.resolve(this.topicStates.get(topicKey(address)) ?? "open");
	}
	setTopicState(address: TopicAddress, state: TopicState): Promise<void> {
		this.topicStates.set(topicKey(address), state);
		return Promise.resolve();
	}
	getThreadState(address: ThreadAddress): Promise<ThreadState> {
		return Promise.resolve(this.threadStates.get(threadKey(address)) ?? "open");
	}
	setThreadState(address: ThreadAddress, state: ThreadState): Promise<void> {
		this.threadStates.set(threadKey(address), state);
		return Promise.resolve();
	}
	setParticipation(
		address: ThreadAddress,
		actorId: string,
		mode: ParticipationMode,
		timestamp: number,
	): Promise<Participant> {
		const key = threadKey(address);
		const byActor = this.participants.get(key) ?? new Map<string, Participant>();
		const existing = byActor.get(actorId);
		const participant: Participant = {
			actorId,
			mode,
			joinedAt: existing?.joinedAt ?? timestamp,
			updatedAt: timestamp,
		};
		byActor.set(actorId, participant);
		this.participants.set(key, byActor);
		return Promise.resolve(participant);
	}
	getParticipant(address: ThreadAddress, actorId: string): Promise<Participant | undefined> {
		return Promise.resolve(this.participants.get(threadKey(address))?.get(actorId));
	}
	listParticipants(address: ThreadAddress, limit: number): Promise<readonly Participant[]> {
		const byActor = this.participants.get(threadKey(address));
		const all = byActor ? [...byActor.values()].sort((left, right) => left.actorId.localeCompare(right.actorId)) : [];
		return Promise.resolve(all.slice(0, limit));
	}
}

/** In-process push adapter with one monotonic cursor per listener. */
export class InMemoryDiscourseSubscriptions implements DiscourseSubscription {
	private readonly subscribers = new Set<Subscriber>();
	publish(events: readonly DiscourseEvent[]): void {
		for (const subscriber of this.subscribers) {
			const pending = events.filter((event) => event.sequence > subscriber.afterSequence);
			if (pending.length === 0) continue;
			subscriber.listener({ events: pending, replayed: false });
			const latest = pending.at(-1);
			if (latest) subscriber.afterSequence = latest.sequence;
		}
	}
	subscribe(afterSequence: number, listener: (batch: SubscriptionBatch) => void): SubscriptionHandle {
		const subscriber: Subscriber = { afterSequence, listener };
		this.subscribers.add(subscriber);
		return { close: () => this.subscribers.delete(subscriber) };
	}
}
