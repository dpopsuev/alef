import {
	IDENTIFIER_MAX_LENGTH,
	POST_CONTENT_MAX_BYTES,
	PROJECTION_MAX_ATTEMPTS,
	PROJECTION_MAX_BATCH,
	QUERY_DEFAULT_LIMIT,
	QUERY_MAX_LIMIT,
	SUBSCRIPTION_MAX_BATCH,
} from "./constants.js";
import type {
	ArtifactReferenceVerifier,
	DiscourseProjection,
	DiscourseStore,
	DiscourseSubscription,
	ListThreadsQuery,
	ListTopicsQuery,
	OpenQuestionsQuery,
	ReadThreadQuery,
	SnapshotQuery,
} from "./ports.js";
import type {
	AppendPostResult,
	BoardAddress,
	DiscourseEvent,
	ForumAddress,
	OpenQuestion,
	Page,
	Participant,
	ParticipationMode,
	Post,
	ProjectionStatus,
	Snapshot,
	SubscriptionBatch,
	SubscriptionHandle,
	ThreadAddress,
	ThreadSummary,
	TopicAddress,
	TopicSummary,
} from "./types.js";
import { parseAppendPostCommand } from "./validation.js";

/** Required driven ports and deterministic identity sources. */
export interface DiscourseServiceOptions {
	readonly store: DiscourseStore;
	readonly subscriptions: DiscourseSubscription;
	readonly createId: () => string;
	readonly now: () => number;
	readonly referenceVerifier?: ArtifactReferenceVerifier;
}
/** Bounded subscription request. */
export interface SubscribeCommand {
	readonly consumerId: string;
	readonly afterSequence?: number;
	readonly limit?: number;
}
/** Public query shape before default limits are applied. */
export type ReadThreadRequest = Omit<ReadThreadQuery, "limit"> & { readonly limit?: number };
/** Public topic query shape before default limits are applied. */
export type ListTopicsRequest = Omit<ListTopicsQuery, "limit"> & { readonly limit?: number };
/** Public thread-list query shape before default limits are applied. */
export type ListThreadsRequest = Omit<ListThreadsQuery, "limit"> & { readonly limit?: number };
/** Public open-question query shape before default limits are applied. */
export type OpenQuestionsRequest = Omit<OpenQuestionsQuery, "limit"> & { readonly limit?: number };
/** Public snapshot query shape before default limits are applied. */
export type SnapshotRequest = Omit<SnapshotQuery, "limit"> & { readonly limit?: number };

/** Reject an empty or oversized identifier. */
function requireIdentifier(name: string, value: string): void {
	if (value.trim().length === 0 || value.length > IDENTIFIER_MAX_LENGTH)
		throw new Error(`${name} must be between 1 and ${IDENTIFIER_MAX_LENGTH} characters`);
}
/** Reject an invalid monotonic sequence. */
function requireSequence(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}
/** Resolve and validate one caller-controlled collection bound. */
function boundedLimit(value: number | undefined, maximum = QUERY_MAX_LIMIT, fallback = QUERY_DEFAULT_LIMIT): number {
	const limit = value ?? fallback;
	if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
		throw new Error(`limit must be between 1 and ${maximum}`);
	return limit;
}
/** Measure a normalized JSON value without retaining another representation. */
function contentByteLength(content: Post["content"]): number {
	return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
/** Validate one thread identity at the application boundary. */
function requireAddress(value: ThreadAddress): void {
	requireIdentifier("boardId", value.boardId);
	requireIdentifier("forumId", value.forumId);
	requireIdentifier("topicId", value.topicId);
	requireIdentifier("threadId", value.threadId);
}
/** Reject a lifecycle transition not permitted from the current state. */
function requireTransition<State extends string>(current: State, next: State, allowed: Record<State, State[]>): void {
	if (!allowed[current].includes(next)) throw new Error(`cannot transition from ${current} to ${next}`);
}

/** Host-neutral forum application service. */
export class DiscourseService {
	constructor(private readonly options: DiscourseServiceOptions) {}

	async post(input: unknown): Promise<AppendPostResult> {
		const command = parseAppendPostCommand(input);
		if (contentByteLength(command.content) > POST_CONTENT_MAX_BYTES)
			throw new Error(`content cannot exceed ${POST_CONTENT_MAX_BYTES} bytes`);
		for (const reference of command.references ?? []) {
			if (!this.options.referenceVerifier || !(await this.options.referenceVerifier.verify(reference))) {
				throw new Error(`artifact reference not verified: ${reference.kind}/${reference.id}`);
			}
		}
		const result = await this.options.store.append(command, this.options.createId(), this.options.now());
		if (!result.replayed && result.events.length > 0) this.options.subscriptions.publish(result.events);
		return { post: result.post, replayed: result.replayed };
	}

	readThread(query: ReadThreadRequest): Promise<Page<Post>> {
		requireAddress(query);
		if (query.afterSequence !== undefined) requireSequence("afterSequence", query.afterSequence);
		return this.options.store.readThread({ ...query, limit: boundedLimit(query.limit) });
	}

	listTopics(query: ListTopicsRequest): Promise<Page<TopicSummary>> {
		requireIdentifier("forumId", query.forumId);
		return this.options.store.listTopics({ ...query, limit: boundedLimit(query.limit) });
	}

	listThreads(query: ListThreadsRequest): Promise<Page<ThreadSummary>> {
		requireIdentifier("forumId", query.forumId);
		requireIdentifier("topicId", query.topicId);
		return this.options.store.listThreads({ ...query, limit: boundedLimit(query.limit) });
	}

	findOpenQuestions(query: OpenQuestionsRequest = {}): Promise<Page<OpenQuestion>> {
		if (query.forumId !== undefined) requireIdentifier("forumId", query.forumId);
		if (query.targetId !== undefined) requireIdentifier("targetId", query.targetId);
		return this.options.store.findOpenQuestions({ ...query, limit: boundedLimit(query.limit) });
	}

	async subscribe(
		command: SubscribeCommand,
		listener: (batch: SubscriptionBatch) => void,
	): Promise<SubscriptionHandle> {
		requireIdentifier("consumerId", command.consumerId);
		const limit = boundedLimit(command.limit, SUBSCRIPTION_MAX_BATCH, SUBSCRIPTION_MAX_BATCH);
		const afterSequence = command.afterSequence ?? (await this.options.store.consumerCursor(command.consumerId));
		requireSequence("afterSequence", afterSequence);
		const replay = await this.options.store.replay(afterSequence, limit);
		if (afterSequence > replay.latestSequence) throw new Error("afterSequence cannot be in the future");
		if (replay.expired || replay.truncated) {
			const event: DiscourseEvent = {
				schemaVersion: "discourse.event.v1",
				type: "subscription-resync-required",
				sequence: replay.latestSequence,
				timestamp: this.options.now(),
				boardId: "*",
				forumId: "*",
				topicId: "*",
				threadId: "*",
				retainedFromSequence: replay.retainedFromSequence,
			};
			listener({ events: [event], replayed: true });
			return { close() {} };
		}
		if (replay.events.length > 0) listener({ events: replay.events, replayed: true });
		return this.options.subscriptions.subscribe(replay.latestSequence, listener);
	}

	acknowledge(consumerId: string, sequence: number): Promise<number> {
		requireIdentifier("consumerId", consumerId);
		requireSequence("sequence", sequence);
		return this.options.store.acknowledge(consumerId, sequence);
	}

	async snapshot(query: SnapshotRequest = {}): Promise<Snapshot> {
		if (query.forumId !== undefined) requireIdentifier("forumId", query.forumId);
		if (query.afterSequence !== undefined) requireSequence("afterSequence", query.afterSequence);
		const result = await this.options.store.snapshot({ ...query, limit: boundedLimit(query.limit) });
		return { throughSequence: result.throughSequence, posts: result.posts };
	}

	async closeThread(address: ThreadAddress): Promise<void> {
		requireAddress(address);
		const current = await this.options.store.getThreadState(address);
		requireTransition(current, "closed", { open: ["closed"], closed: [], archived: [] });
		await this.options.store.setThreadState(address, "closed", this.options.now());
	}

	async reopenThread(address: ThreadAddress): Promise<void> {
		requireAddress(address);
		const current = await this.options.store.getThreadState(address);
		requireTransition(current, "open", { open: [], closed: ["open"], archived: [] });
		await this.options.store.setThreadState(address, "open", this.options.now());
	}

	async archiveThread(address: ThreadAddress): Promise<void> {
		requireAddress(address);
		const current = await this.options.store.getThreadState(address);
		requireTransition(current, "archived", { open: [], closed: ["archived"], archived: [] });
		await this.options.store.setThreadState(address, "archived", this.options.now());
	}

	async resolveTopic(address: TopicAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		requireIdentifier("forumId", address.forumId);
		requireIdentifier("topicId", address.topicId);
		const current = await this.options.store.getTopicState(address);
		requireTransition(current, "resolved", { open: ["resolved"], resolved: [], archived: [] });
		await this.options.store.setTopicState(address, "resolved", this.options.now());
	}

	async reopenTopic(address: TopicAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		requireIdentifier("forumId", address.forumId);
		requireIdentifier("topicId", address.topicId);
		const current = await this.options.store.getTopicState(address);
		requireTransition(current, "open", { open: [], resolved: ["open"], archived: [] });
		await this.options.store.setTopicState(address, "open", this.options.now());
	}

	async archiveTopic(address: TopicAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		requireIdentifier("forumId", address.forumId);
		requireIdentifier("topicId", address.topicId);
		const current = await this.options.store.getTopicState(address);
		requireTransition(current, "archived", { open: [], resolved: ["archived"], archived: [] });
		await this.options.store.setTopicState(address, "archived", this.options.now());
	}

	async restrictForum(address: ForumAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		requireIdentifier("forumId", address.forumId);
		const current = await this.options.store.getForumState(address);
		requireTransition(current, "read-only", { open: ["read-only"], "read-only": [], archived: [] });
		await this.options.store.setForumState(address, "read-only", this.options.now());
	}

	async archiveForum(address: ForumAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		requireIdentifier("forumId", address.forumId);
		const current = await this.options.store.getForumState(address);
		requireTransition(current, "archived", { open: [], "read-only": ["archived"], archived: [] });
		await this.options.store.setForumState(address, "archived", this.options.now());
	}

	async archiveBoard(address: BoardAddress): Promise<void> {
		requireIdentifier("boardId", address.boardId);
		const current = await this.options.store.getBoardState(address);
		requireTransition(current, "archived", { active: ["archived"], archived: [] });
		await this.options.store.setBoardState(address, "archived", this.options.now());
	}

	join(address: ThreadAddress, actorId: string, mode: ParticipationMode = "subscribed"): Promise<Participant> {
		requireAddress(address);
		requireIdentifier("actorId", actorId);
		return this.options.store.setParticipation(address, actorId, mode, this.options.now());
	}

	leave(address: ThreadAddress, actorId: string): Promise<Participant> {
		requireAddress(address);
		requireIdentifier("actorId", actorId);
		return this.options.store.setParticipation(address, actorId, "left", this.options.now());
	}

	listParticipants(address: ThreadAddress, limit?: number): Promise<readonly Participant[]> {
		requireAddress(address);
		return this.options.store.listParticipants(address, boundedLimit(limit));
	}

	async project(projection: DiscourseProjection, limit = PROJECTION_MAX_BATCH): Promise<ProjectionStatus> {
		requireIdentifier("projection id", projection.id);
		const records = await this.options.store.readProjectionOutbox(
			projection.id,
			boundedLimit(limit, PROJECTION_MAX_BATCH, PROJECTION_MAX_BATCH),
		);
		let failure: string | undefined;
		for (const record of records) {
			let projected = false;
			for (let attempt = 0; attempt < PROJECTION_MAX_ATTEMPTS; attempt += 1) {
				try {
					await projection.project(record);
					await this.options.store.acknowledgeProjection(projection.id, record.sequence);
					projected = true;
					break;
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
			}
			if (!projected) break;
		}
		const checkpoint = await this.options.store.projectionCheckpoint(projection.id);
		const latestSequence = await this.options.store.latestPostSequence();
		const pending = await this.options.store.projectionPending(projection.id);
		return {
			projectionId: projection.id,
			checkpoint,
			latestSequence,
			pending,
			state: failure ? "failed" : pending === 0 ? "current" : "lagging",
			...(failure === undefined ? {} : { failure }),
		};
	}
}
