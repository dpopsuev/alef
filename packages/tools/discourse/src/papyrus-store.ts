import type {
	ArtifactReferenceVerifier,
	DiscourseStore,
	EventReplay,
	ListThreadsQuery,
	ListTopicsQuery,
	OpenQuestionsQuery,
	ReadThreadQuery,
	SnapshotQuery,
	StoredAppendResult,
} from "@danypops/discourse/ports";
import type {
	AppendPostCommand,
	ArtifactReference,
	BoardAddress,
	BoardState,
	ForumAddress,
	ForumState,
	OpenQuestion,
	Page,
	Participant,
	ParticipationMode,
	Post,
	ProjectionRecord,
	ThreadAddress,
	ThreadState,
	ThreadSummary,
	TopicAddress,
	TopicState,
	TopicSummary,
} from "@danypops/discourse/types";

/** Authenticated operation boundary exposed by the durable Context Mesh service. */
export interface PapyrusOperationCall {
	call<Input extends Record<string, unknown>, Output>(
		operation: "artifact.show" | "discourse.store",
		input: Input,
	): Promise<Output>;
}

/** Map the generic forum persistence port onto one namespaced Papyrus graph store. */
export class PapyrusDiscourseStore implements DiscourseStore {
	constructor(
		private readonly client: PapyrusOperationCall,
		private readonly storeId: string,
		private readonly eventRetention?: number,
	) {
		if (storeId.length === 0) throw new Error("storeId is required");
	}

	private call<Output>(action: string, input: Record<string, unknown> = {}): Promise<Output> {
		return this.client.call<Record<string, unknown>, Output>("discourse.store", {
			action,
			store_id: this.storeId,
			...input,
		});
	}

	append(command: AppendPostCommand, postId: string, timestamp: number): Promise<StoredAppendResult> {
		return this.call("append", {
			command,
			post_id: postId,
			timestamp,
			...(this.eventRetention === undefined ? {} : { event_retention: this.eventRetention }),
		});
	}

	readThread(query: ReadThreadQuery): Promise<Page<Post>> {
		return this.call("read_thread", { ...query });
	}

	listTopics(query: ListTopicsQuery): Promise<Page<TopicSummary>> {
		return this.call("list_topics", { ...query });
	}

	listThreads(query: ListThreadsQuery): Promise<Page<ThreadSummary>> {
		return this.call("list_threads", { ...query });
	}

	findOpenQuestions(query: OpenQuestionsQuery): Promise<Page<OpenQuestion>> {
		return this.call("open_questions", { ...query });
	}

	replay(afterSequence: number, limit: number): Promise<EventReplay> {
		return this.call("replay", { after_sequence: afterSequence, limit });
	}

	snapshot(query: SnapshotQuery): Promise<{ posts: Page<Post>; throughSequence: number }> {
		return this.call("snapshot", { ...query });
	}

	acknowledge(consumerId: string, sequence: number): Promise<number> {
		return this.call("acknowledge", { consumer_id: consumerId, sequence });
	}

	consumerCursor(consumerId: string): Promise<number> {
		return this.call("consumer_cursor", { consumer_id: consumerId });
	}

	readProjectionOutbox(projectionId: string, limit: number): Promise<readonly ProjectionRecord[]> {
		return this.call("read_projection_outbox", { projection_id: projectionId, limit });
	}

	async acknowledgeProjection(projectionId: string, sequence: number): Promise<void> {
		await this.call("acknowledge_projection", { projection_id: projectionId, sequence });
	}

	projectionCheckpoint(projectionId: string): Promise<number> {
		return this.call("projection_checkpoint", { projection_id: projectionId });
	}

	projectionPending(projectionId: string): Promise<number> {
		return this.call("projection_pending", { projection_id: projectionId });
	}

	latestPostSequence(): Promise<number> {
		return this.call("latest_post_sequence");
	}

	getBoardState(address: BoardAddress): Promise<BoardState> {
		return this.call("get_board_state", { ...address });
	}
	setBoardState(address: BoardAddress, state: BoardState, timestamp: number): Promise<void> {
		return this.call("set_board_state", { ...address, state, timestamp });
	}
	getForumState(address: ForumAddress): Promise<ForumState> {
		return this.call("get_forum_state", { ...address });
	}
	setForumState(address: ForumAddress, state: ForumState, timestamp: number): Promise<void> {
		return this.call("set_forum_state", { ...address, state, timestamp });
	}
	getTopicState(address: TopicAddress): Promise<TopicState> {
		return this.call("get_topic_state", { ...address });
	}
	setTopicState(address: TopicAddress, state: TopicState, timestamp: number): Promise<void> {
		return this.call("set_topic_state", { ...address, state, timestamp });
	}
	getThreadState(address: ThreadAddress): Promise<ThreadState> {
		return this.call("get_thread_state", { ...address });
	}
	setThreadState(address: ThreadAddress, state: ThreadState, timestamp: number): Promise<void> {
		return this.call("set_thread_state", { ...address, state, timestamp });
	}
	setParticipation(
		address: ThreadAddress,
		actorId: string,
		mode: ParticipationMode,
		timestamp: number,
	): Promise<Participant> {
		return this.call("set_participation", { ...address, actor_id: actorId, mode, timestamp });
	}
	getParticipant(address: ThreadAddress, actorId: string): Promise<Participant | undefined> {
		return this.call("get_participant", { ...address, actor_id: actorId });
	}
	listParticipants(address: ThreadAddress, limit: number): Promise<readonly Participant[]> {
		return this.call("list_participants", { ...address, limit });
	}
}

/** Verify references at the application boundary without mutating graph state. */
export class PapyrusArtifactReferenceVerifier implements ArtifactReferenceVerifier {
	constructor(private readonly client: PapyrusOperationCall) {}

	async verify(reference: ArtifactReference): Promise<boolean> {
		const artifact = await this.client.call<{ id: string }, { kind: string } | null>("artifact.show", {
			id: reference.id,
		});
		return artifact?.kind === reference.kind;
	}
}
