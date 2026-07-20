import { EVENT_RETENTION_DEFAULT } from "@dpopsuev/discourse-capability/constants";
import type {
	DiscourseStore,
	EventReplay,
	ListThreadsQuery,
	ListTopicsQuery,
	OpenQuestionsQuery,
	ReadThreadQuery,
	SnapshotQuery,
	StoredAppendResult,
} from "@dpopsuev/discourse-capability/ports";
import type {
	AppendPostCommand,
	DiscourseEvent,
	DiscourseEventType,
	JsonValue,
	OpenQuestion,
	Page,
	Post,
	ProjectionRecord,
	ThreadSummary,
	TopicSummary,
} from "@dpopsuev/discourse-capability/types";
import type { Client, Row, Transaction } from "@libsql/client";
import { z } from "zod";

const persistedIdentifier = z.string().min(1);
const referencesSchema = z.array(z.object({ kind: persistedIdentifier, id: persistedIdentifier }).strict());
const PARTICIPANT_LIMIT = 100;
const SQLITE_WRITE_QUEUE_MAX = 256;
const eventSchema = z
	.object({
		schemaVersion: z.literal("discourse.event.v1"),
		type: z.enum([
			"post-added",
			"thread-changed",
			"question-opened",
			"question-answered",
			"subscription-resync-required",
		]),
		sequence: z.number(),
		timestamp: z.number(),
		forumId: persistedIdentifier,
		topicId: persistedIdentifier,
		threadId: persistedIdentifier,
		postId: persistedIdentifier.optional(),
		operationId: persistedIdentifier.optional(),
		correlationId: persistedIdentifier.optional(),
		causationId: persistedIdentifier.optional(),
		responseId: persistedIdentifier.optional(),
		retainedFromSequence: z.number().optional(),
	})
	.strict();

/** Structured question columns stored for bounded matching queries. */
interface QuestionColumns {
	readonly questionType?: "question" | "answer";
	readonly responseId?: string;
	readonly targetId?: string;
}
/** Convert unknown SQLite text into a required string. */
function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
	const value = row[name];
	if (typeof value !== "string") throw new Error(`invalid persisted ${name}`);
	return value;
}
/** Convert an optional SQLite text column. */
function optionalString(row: Readonly<Record<string, unknown>>, name: string): string | undefined {
	const value = row[name];
	return typeof value === "string" ? value : undefined;
}
/** Convert unknown SQLite numeric data into a safe number. */
function requiredNumber(row: Readonly<Record<string, unknown>>, name: string): number {
	const value = Number(row[name]);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid persisted ${name}`);
	return value;
}
/** Parse persisted JSON and validate its runtime shape. */
function parsedJson(text: string): unknown {
	const value: unknown = JSON.parse(text);
	return value;
}
/** Decode one persisted post. */
function postFromRow(row: Row): Post {
	return {
		id: requiredString(row, "id"),
		sequence: requiredNumber(row, "sequence"),
		operationId: requiredString(row, "operation_id"),
		forumId: requiredString(row, "forum_id"),
		topicId: requiredString(row, "topic_id"),
		threadId: requiredString(row, "thread_id"),
		authorId: requiredString(row, "author_id"),
		content: z.json().parse(parsedJson(requiredString(row, "content_json"))),
		timestamp: requiredNumber(row, "timestamp"),
		references: referencesSchema.parse(parsedJson(requiredString(row, "references_json"))),
		...(optionalString(row, "correlation_id") === undefined
			? {}
			: { correlationId: optionalString(row, "correlation_id") }),
		...(optionalString(row, "causation_id") === undefined
			? {}
			: { causationId: optionalString(row, "causation_id") }),
		...(optionalString(row, "reply_to_post_id") === undefined
			? {}
			: { replyToPostId: optionalString(row, "reply_to_post_id") }),
	};
}
/** Build one bounded page from a limit-plus-one query. */
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
/** Read structured question metadata without parsing display text. */
function questionColumns(content: JsonValue): QuestionColumns {
	if (typeof content !== "object" || content === null || Array.isArray(content)) return {};
	const record = z.record(z.string().min(1), z.json()).parse(content);
	const questionType = record.type;
	const responseId = record.responseId;
	const targetId = record.targetId;
	if ((questionType !== "question" && questionType !== "answer") || typeof responseId !== "string") return {};
	return { questionType, responseId, ...(typeof targetId === "string" ? { targetId } : {}) };
}
/** Create the content-free events committed with one post. */
function eventsFor(
	command: AppendPostCommand,
	postId: string,
	timestamp: number,
	firstSequence: number,
): DiscourseEvent[] {
	const question = questionColumns(command.content);
	const types: Array<{ type: DiscourseEventType; responseId?: string }> = [
		{ type: "post-added" },
		{ type: "thread-changed" },
	];
	if (question.questionType)
		types.push({
			type: question.questionType === "question" ? "question-opened" : "question-answered",
			responseId: question.responseId,
		});
	return types.map((metadata, index) => ({
		schemaVersion: "discourse.event.v1",
		type: metadata.type,
		sequence: firstSequence + index,
		timestamp,
		forumId: command.forumId,
		topicId: command.topicId,
		threadId: command.threadId,
		postId,
		operationId: command.operationId,
		...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
		...(command.causationId === undefined ? {} : { causationId: command.causationId }),
		...(metadata.responseId === undefined ? {} : { responseId: metadata.responseId }),
	}));
}
/** Close a transaction without masking the operation result. */
function closeTransaction(transaction: Transaction): void {
	try {
		transaction.close();
	} catch {
		/* already committed or rolled back */
	}
}

/** Durable session-scoped persistence adapter with atomic events and outbox records. */
export class SqliteCapabilityDiscourseStore implements DiscourseStore {
	private writeQueue: Promise<void> = Promise.resolve();
	private pendingWrites = 0;

	constructor(
		private readonly client: Client,
		private readonly sessionId: string,
		private readonly eventRetention = EVENT_RETENTION_DEFAULT,
	) {}

	append(command: AppendPostCommand, postId: string, timestamp: number): Promise<StoredAppendResult> {
		if (this.pendingWrites >= SQLITE_WRITE_QUEUE_MAX)
			return Promise.reject(new Error("discourse write queue capacity reached"));
		this.pendingWrites += 1;
		const operation = this.writeQueue.then(async () => this.appendTransaction(command, postId, timestamp));
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.finally(() => {
			this.pendingWrites -= 1;
		});
	}

	private async appendTransaction(
		command: AppendPostCommand,
		postId: string,
		timestamp: number,
	): Promise<StoredAppendResult> {
		const commandJson = JSON.stringify(command);
		const transaction = await this.client.transaction("write");
		try {
			const prior = await transaction.execute({
				sql: "SELECT * FROM discourse_capability_posts WHERE session_id = ? AND operation_id = ?",
				args: [this.sessionId, command.operationId],
			});
			if (prior.rows[0]) {
				if (requiredString(prior.rows[0], "command_json") !== commandJson)
					throw new Error(`operation conflict: ${command.operationId}`);
				await transaction.commit();
				return { post: postFromRow(prior.rows[0]), replayed: true, events: [] };
			}
			if (command.replyToPostId) {
				const parent = await transaction.execute({
					sql: "SELECT forum_id, topic_id, thread_id FROM discourse_capability_posts WHERE session_id = ? AND id = ?",
					args: [this.sessionId, command.replyToPostId],
				});
				const row = parent.rows[0];
				if (!row) throw new Error(`reply target not found: ${command.replyToPostId}`);
				if (
					requiredString(row, "forum_id") !== command.forumId ||
					requiredString(row, "topic_id") !== command.topicId ||
					requiredString(row, "thread_id") !== command.threadId
				)
					throw new Error("reply target must belong to the same thread");
			}
			const maximum = await transaction.execute({
				sql: "SELECT COALESCE(MAX(sequence), 0) AS value FROM discourse_capability_events WHERE session_id = ?",
				args: [this.sessionId],
			});
			const firstSequence = requiredNumber(maximum.rows[0] ?? { value: 0 }, "value") + 1;
			const events = eventsFor(command, postId, timestamp, firstSequence);
			const question = questionColumns(command.content);
			await transaction.execute({
				sql: "INSERT INTO discourse_capability_posts (session_id, sequence, id, operation_id, command_json, forum_id, topic_id, thread_id, author_id, content_json, timestamp, correlation_id, causation_id, reply_to_post_id, references_json, question_type, response_id, target_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				args: [
					this.sessionId,
					firstSequence,
					postId,
					command.operationId,
					commandJson,
					command.forumId,
					command.topicId,
					command.threadId,
					command.authorId,
					JSON.stringify(command.content),
					timestamp,
					command.correlationId ?? null,
					command.causationId ?? null,
					command.replyToPostId ?? null,
					JSON.stringify(command.references ?? []),
					question.questionType ?? null,
					question.responseId ?? null,
					question.targetId ?? null,
				],
			});
			for (const event of events)
				await transaction.execute({
					sql: "INSERT INTO discourse_capability_events (session_id, sequence, event_json) VALUES (?, ?, ?)",
					args: [this.sessionId, event.sequence, JSON.stringify(event)],
				});
			const lastEvent = events.at(-1);
			if (!lastEvent) throw new Error("append produced no events");
			const retentionFloor = lastEvent.sequence - this.eventRetention;
			await transaction.execute({
				sql: "DELETE FROM discourse_capability_events WHERE session_id = ? AND sequence <= ?",
				args: [this.sessionId, retentionFloor],
			});
			await transaction.commit();
			const post: Post = {
				id: postId,
				sequence: firstSequence,
				operationId: command.operationId,
				forumId: command.forumId,
				topicId: command.topicId,
				threadId: command.threadId,
				authorId: command.authorId,
				content: command.content,
				timestamp,
				references: [...(command.references ?? [])],
				...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
				...(command.causationId === undefined ? {} : { causationId: command.causationId }),
				...(command.replyToPostId === undefined ? {} : { replyToPostId: command.replyToPostId }),
			};
			return { post, replayed: false, events };
		} catch (error) {
			await transaction.rollback();
			throw error;
		} finally {
			closeTransaction(transaction);
		}
	}

	async readThread(query: ReadThreadQuery): Promise<Page<Post>> {
		const result = await this.client.execute({
			sql: "SELECT * FROM discourse_capability_posts WHERE session_id = ? AND forum_id = ? AND topic_id = ? AND thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
			args: [
				this.sessionId,
				query.forumId,
				query.topicId,
				query.threadId,
				query.afterSequence ?? 0,
				query.limit + 1,
			],
		});
		return page(result.rows.map(postFromRow), query.limit, (post) => post.sequence);
	}
	async listTopics(query: ListTopicsQuery): Promise<Page<TopicSummary>> {
		const result = await this.client.execute({
			sql: "SELECT forum_id, topic_id, COUNT(DISTINCT thread_id) AS thread_count, COUNT(*) AS post_count, MAX(timestamp) AS last_activity FROM discourse_capability_posts WHERE session_id = ? AND forum_id = ? GROUP BY forum_id, topic_id ORDER BY topic_id LIMIT ?",
			args: [this.sessionId, query.forumId, query.limit + 1],
		});
		return page(
			result.rows.map((row) => ({
				forumId: requiredString(row, "forum_id"),
				topicId: requiredString(row, "topic_id"),
				threadCount: requiredNumber(row, "thread_count"),
				postCount: requiredNumber(row, "post_count"),
				lastActivity: requiredNumber(row, "last_activity"),
			})),
			query.limit,
		);
	}
	async listThreads(query: ListThreadsQuery): Promise<Page<ThreadSummary>> {
		const result = await this.client.execute({
			sql: "SELECT forum_id, topic_id, thread_id, COUNT(*) AS post_count, MAX(timestamp) AS last_activity FROM discourse_capability_posts WHERE session_id = ? AND forum_id = ? AND topic_id = ? GROUP BY forum_id, topic_id, thread_id ORDER BY thread_id LIMIT ?",
			args: [this.sessionId, query.forumId, query.topicId, query.limit + 1],
		});
		const summaries = await Promise.all(
			result.rows.map(async (row): Promise<ThreadSummary> => {
				const participants = await this.client.execute({
					sql: "SELECT DISTINCT author_id FROM discourse_capability_posts WHERE session_id = ? AND forum_id = ? AND topic_id = ? AND thread_id = ? ORDER BY author_id LIMIT ?",
					args: [
						this.sessionId,
						query.forumId,
						query.topicId,
						requiredString(row, "thread_id"),
						PARTICIPANT_LIMIT + 1,
					],
				});
				return {
					forumId: requiredString(row, "forum_id"),
					topicId: requiredString(row, "topic_id"),
					threadId: requiredString(row, "thread_id"),
					postCount: requiredNumber(row, "post_count"),
					participantIds: participants.rows
						.slice(0, PARTICIPANT_LIMIT)
						.map((entry) => requiredString(entry, "author_id")),
					lastActivity: requiredNumber(row, "last_activity"),
				};
			}),
		);
		return page(summaries, query.limit);
	}
	async findOpenQuestions(query: OpenQuestionsQuery): Promise<Page<OpenQuestion>> {
		const result = await this.client.execute({
			sql: "SELECT p.* FROM discourse_capability_posts p WHERE p.session_id = ? AND p.question_type = 'question' AND (? IS NULL OR p.forum_id = ?) AND (? IS NULL OR p.target_id IS NULL OR p.target_id = ?) AND NOT EXISTS (SELECT 1 FROM discourse_capability_posts a WHERE a.session_id = p.session_id AND a.question_type = 'answer' AND a.response_id = p.response_id) ORDER BY p.sequence LIMIT ?",
			args: [
				this.sessionId,
				query.forumId ?? null,
				query.forumId ?? null,
				query.targetId ?? null,
				query.targetId ?? null,
				query.limit + 1,
			],
		});
		return page(
			result.rows.map((row) => ({ responseId: requiredString(row, "response_id"), post: postFromRow(row) })),
			query.limit,
			(question) => question.post.sequence,
		);
	}
	async replay(afterSequence: number, limit: number): Promise<EventReplay> {
		const bounds = await this.client.execute({
			sql: "SELECT COALESCE(MIN(sequence), 0) AS minimum, COALESCE(MAX(sequence), 0) AS maximum FROM discourse_capability_events WHERE session_id = ?",
			args: [this.sessionId],
		});
		const retainedFromSequence = requiredNumber(bounds.rows[0] ?? { minimum: 0 }, "minimum");
		const latestSequence = requiredNumber(bounds.rows[0] ?? { maximum: 0 }, "maximum");
		const expired = retainedFromSequence > 0 && afterSequence > 0 && afterSequence < retainedFromSequence - 1;
		const result = expired
			? undefined
			: await this.client.execute({
					sql: "SELECT event_json FROM discourse_capability_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
					args: [this.sessionId, afterSequence, limit + 1],
				});
		const events = result?.rows.map((row) => eventSchema.parse(parsedJson(requiredString(row, "event_json")))) ?? [];
		return {
			events: events.slice(0, limit),
			retainedFromSequence,
			latestSequence,
			expired,
			truncated: events.length > limit,
		};
	}
	async snapshot(query: SnapshotQuery): Promise<{ posts: Page<Post>; throughSequence: number }> {
		const result = await this.client.execute({
			sql: "SELECT * FROM discourse_capability_posts WHERE session_id = ? AND sequence > ? AND (? IS NULL OR forum_id = ?) ORDER BY sequence LIMIT ?",
			args: [
				this.sessionId,
				query.afterSequence ?? 0,
				query.forumId ?? null,
				query.forumId ?? null,
				query.limit + 1,
			],
		});
		const latest = await this.client.execute({
			sql: "SELECT COALESCE(MAX(sequence), 0) AS value FROM discourse_capability_events WHERE session_id = ?",
			args: [this.sessionId],
		});
		return {
			posts: page(result.rows.map(postFromRow), query.limit, (post) => post.sequence),
			throughSequence: requiredNumber(latest.rows[0] ?? { value: 0 }, "value"),
		};
	}
	async acknowledge(consumerId: string, sequence: number): Promise<number> {
		const latest = (await this.replay(sequence, 1)).latestSequence;
		if (sequence > latest) throw new Error(`cannot acknowledge future sequence ${sequence}`);
		await this.client.execute({
			sql: "INSERT INTO discourse_capability_cursors (session_id, consumer_id, sequence) VALUES (?, ?, ?) ON CONFLICT(session_id, consumer_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)",
			args: [this.sessionId, consumerId, sequence],
		});
		return this.consumerCursor(consumerId);
	}
	async consumerCursor(consumerId: string): Promise<number> {
		const result = await this.client.execute({
			sql: "SELECT sequence FROM discourse_capability_cursors WHERE session_id = ? AND consumer_id = ?",
			args: [this.sessionId, consumerId],
		});
		return result.rows[0] ? requiredNumber(result.rows[0], "sequence") : 0;
	}
	async readProjectionOutbox(projectionId: string, limit: number): Promise<readonly ProjectionRecord[]> {
		const checkpoint = await this.projectionCheckpoint(projectionId);
		const result = await this.client.execute({
			sql: "SELECT * FROM discourse_capability_posts WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
			args: [this.sessionId, checkpoint, limit],
		});
		return result.rows.map((row) => {
			const post = postFromRow(row);
			return { sequence: post.sequence, post };
		});
	}
	async acknowledgeProjection(projectionId: string, sequence: number): Promise<void> {
		await this.client.execute({
			sql: "INSERT INTO discourse_capability_projection_cursors (session_id, projection_id, sequence) VALUES (?, ?, ?) ON CONFLICT(session_id, projection_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)",
			args: [this.sessionId, projectionId, sequence],
		});
	}
	async projectionCheckpoint(projectionId: string): Promise<number> {
		const result = await this.client.execute({
			sql: "SELECT sequence FROM discourse_capability_projection_cursors WHERE session_id = ? AND projection_id = ?",
			args: [this.sessionId, projectionId],
		});
		return result.rows[0] ? requiredNumber(result.rows[0], "sequence") : 0;
	}
	async projectionPending(projectionId: string): Promise<number> {
		const checkpoint = await this.projectionCheckpoint(projectionId);
		const result = await this.client.execute({
			sql: "SELECT COUNT(*) AS value FROM discourse_capability_posts WHERE session_id = ? AND sequence > ?",
			args: [this.sessionId, checkpoint],
		});
		return requiredNumber(result.rows[0] ?? { value: 0 }, "value");
	}
	async latestPostSequence(): Promise<number> {
		const result = await this.client.execute({
			sql: "SELECT COALESCE(MAX(sequence), 0) AS value FROM discourse_capability_posts WHERE session_id = ?",
			args: [this.sessionId],
		});
		return requiredNumber(result.rows[0] ?? { value: 0 }, "value");
	}
}
