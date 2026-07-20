import { randomUUID } from "node:crypto";
import { InMemoryDiscourseStore, InMemoryDiscourseSubscriptions } from "@dpopsuev/discourse-capability/memory-store";
import type { DiscourseProjection, DiscourseStore, DiscourseSubscription } from "@dpopsuev/discourse-capability/ports";
import { DiscourseService } from "@dpopsuev/discourse-capability/service";
import type { Post as CapabilityPost, DiscourseEvent, ProjectionStatus } from "@dpopsuev/discourse-capability/types";
import type { DiscourseBackend } from "./backend.js";
import type { Post, PostWriteOptions, ThreadInfo, TopicSummary } from "./types.js";

const DEFAULT_FORUM_ID = "default";
const INTERNAL_QUERY_LIMIT = 100;

/** Driven ports and optional projection observers for one adapter composition. */
export interface CapabilityDiscourseBackendOptions {
	readonly store?: DiscourseStore;
	readonly subscriptions?: DiscourseSubscription;
	readonly projections?: readonly DiscourseProjection[];
	readonly observeProjection?: (status: ProjectionStatus) => void;
}

/** Convert the capability DTO to the established adapter DTO. */
function legacyPost(post: CapabilityPost): Post {
	return {
		id: post.id,
		topic: post.topicId,
		thread: post.threadId,
		author: post.authorId,
		content: post.content,
		timestamp: post.timestamp,
		...(post.replyToPostId === undefined ? {} : { replyToPostId: post.replyToPostId }),
		references: post.references.map((reference) => `${reference.kind}:${reference.id}`),
	};
}

/** Thin compatibility facade over the shared forum application service. */
export class CapabilityDiscourseBackend implements DiscourseBackend {
	readonly capability: DiscourseService;
	private readonly pendingEvents: DiscourseEvent[] = [];
	private readonly projections: readonly DiscourseProjection[];
	private readonly observeProjection: ((status: ProjectionStatus) => void) | undefined;
	private subscription: Promise<void> | undefined;

	constructor(options: CapabilityDiscourseBackendOptions = {}) {
		this.projections = options.projections ?? [];
		this.observeProjection = options.observeProjection;
		this.capability = new DiscourseService({
			store: options.store ?? new InMemoryDiscourseStore(),
			subscriptions: options.subscriptions ?? new InMemoryDiscourseSubscriptions(),
			createId: randomUUID,
			now: Date.now,
		});
	}

	async append(
		topic: string,
		thread: string,
		author: string,
		content: unknown,
		opts: PostWriteOptions = {},
	): Promise<Post> {
		await this.ensureSubscription();
		const result = await this.capability.post({
			schemaVersion: "discourse.command.v1",
			operationId: opts.operationId ?? randomUUID(),
			forumId: DEFAULT_FORUM_ID,
			topicId: topic,
			threadId: thread,
			authorId: author,
			content,
			...(opts.correlationId === undefined ? {} : { correlationId: opts.correlationId }),
			...(opts.causationId === undefined ? {} : { causationId: opts.causationId }),
			...(opts.replyToPostId === undefined ? {} : { replyToPostId: opts.replyToPostId }),
		});
		for (const projection of this.projections) {
			const status = await this.capability.project(projection);
			this.observeProjection?.(status);
		}
		return legacyPost(result.post);
	}

	async readThread(topic: string, thread: string, since?: number): Promise<Post[]> {
		const result = await this.capability.readThread({
			forumId: DEFAULT_FORUM_ID,
			topicId: topic,
			threadId: thread,
			limit: INTERNAL_QUERY_LIMIT,
		});
		return result.items.filter((post) => since === undefined || post.timestamp > since).map(legacyPost);
	}

	async listTopics(): Promise<string[]> {
		return (await this.capability.listTopics({ forumId: DEFAULT_FORUM_ID, limit: INTERNAL_QUERY_LIMIT })).items.map(
			(topic) => topic.topicId,
		);
	}

	async listThreads(topic: string): Promise<string[]> {
		return (
			await this.capability.listThreads({ forumId: DEFAULT_FORUM_ID, topicId: topic, limit: INTERNAL_QUERY_LIMIT })
		).items.map((thread) => thread.threadId);
	}

	async threadInfo(topic: string, thread: string): Promise<ThreadInfo> {
		const summary = (
			await this.capability.listThreads({ forumId: DEFAULT_FORUM_ID, topicId: topic, limit: INTERNAL_QUERY_LIMIT })
		).items.find((item) => item.threadId === thread);
		return summary
			? {
					name: summary.threadId,
					posts: summary.postCount,
					participants: summary.participantIds,
					lastActivity: summary.lastActivity,
				}
			: { name: thread, posts: 0, participants: [], lastActivity: 0 };
	}

	async topicSummaries(): Promise<TopicSummary[]> {
		const topics = await this.listTopics();
		return Promise.all(topics.map(async (topic) => ({ topic, threads: await this.listThreads(topic) })));
	}

	async readNewPosts(since: number): Promise<Post[]> {
		if (since === 0) {
			const snapshot = await this.capability.snapshot({ forumId: DEFAULT_FORUM_ID, limit: INTERNAL_QUERY_LIMIT });
			return snapshot.posts.items.map(legacyPost);
		}
		return this.readPendingPosts();
	}

	/** Drain posts delivered by the bounded sequenced subscription. */
	async readPendingPosts(): Promise<Post[]> {
		await this.ensureSubscription();
		const events = this.pendingEvents.splice(0).filter((event) => event.type === "post-added");
		const posts = await Promise.all(
			events.map(async (event) => {
				const page = await this.capability.readThread({
					forumId: event.forumId,
					topicId: event.topicId,
					threadId: event.threadId,
					afterSequence: event.sequence - 1,
					limit: 1,
				});
				return page.items[0];
			}),
		);
		return posts.filter((post): post is CapabilityPost => post !== undefined).map(legacyPost);
	}

	private ensureSubscription(): Promise<void> {
		this.subscription ??= this.capability
			.subscribe({ consumerId: `adapter-${randomUUID()}` }, (batch) => {
				this.pendingEvents.push(...batch.events);
				if (this.pendingEvents.length > INTERNAL_QUERY_LIMIT)
					this.pendingEvents.splice(0, this.pendingEvents.length - INTERNAL_QUERY_LIMIT);
			})
			.then(() => undefined);
		return this.subscription;
	}
}
