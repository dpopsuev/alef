import { randomUUID } from "node:crypto";
import { InMemoryDiscourseStore, InMemoryDiscourseSubscriptions } from "@danypops/discourse/memory-store";
import { DiscourseService } from "@danypops/discourse/service";
import type { DiscourseEvent, Post } from "@danypops/discourse/types";
import type {
	Adapter,
	BaseAdapterOptions,
	CommandHandlerCtx,
	ContextAssemblyHandler,
} from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import {
	CONSUMER_ID,
	DEFAULT_AUTHOR_ID,
	DEFAULT_BOARD_ID,
	DEFAULT_FORUM_ID,
	NATIVE_EVENT_LIMIT,
	NATIVE_QUERY_LIMIT,
} from "./constants.js";

/** Adapter construction options; the forum backend is always the shared bounded in-memory store. */
export type DiscourseAdapterOptions = BaseAdapterOptions;

const FORUM_POST = {
	name: "discourse.post",
	description: "Append one idempotent forum post or reply. Safe for concurrent writers.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name (e.g. 'collectors', 'reviews', 'findings')"),
		thread: z.string().min(1).describe("Thread name within the topic (e.g. 'long-functions', 'nesting')"),
		content: z.unknown().describe("Message content — any JSON-serializable value"),
		author: z.string().optional().describe("Author name (defaults to agent identity)"),
		replyToPostId: z.string().optional().describe("Reply to this existing post id within the same thread"),
	}),
};

const FORUM_READ = {
	name: "discourse.read",
	description: "Read one bounded forum thread page.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name"),
		thread: z.string().min(1).describe("Thread name"),
		afterSequence: z.number().min(0).optional().describe("Only return posts after this sequence number"),
	}),
};

const FORUM_LIST = {
	name: "discourse.list",
	description: "List bounded forum topics or threads with metadata.",
	inputSchema: z.object({
		topic: z.string().optional().describe("List threads in this topic. Omit to list all topics."),
	}),
};

/** Render one post for human/agent context without changing its machine DTO. */
function renderPost(post: Post): string {
	const body = typeof post.content === "string" ? post.content : JSON.stringify(post.content);
	return `[${post.topicId}/${post.threadId}] @${post.authorId}: ${body}`;
}

/** Create the alef-discourse adapter: forum tools plus sequenced context injection. */
export function createDiscourseAdapter(opts: DiscourseAdapterOptions = {}): Adapter {
	const service = new DiscourseService({
		store: new InMemoryDiscourseStore(),
		subscriptions: new InMemoryDiscourseSubscriptions(),
		createId: randomUUID,
		now: Date.now,
	});
	const pendingEvents: DiscourseEvent[] = [];
	let resyncRequired = false;
	const subscriptionReady = service.subscribe({ consumerId: CONSUMER_ID }, (batch) => {
		if (batch.events.some((event) => event.type === "subscription-resync-required")) resyncRequired = true;
		pendingEvents.push(...batch.events.filter((event) => event.type === "post-added"));
		if (pendingEvents.length > NATIVE_EVENT_LIMIT) {
			pendingEvents.splice(0, pendingEvents.length - NATIVE_EVENT_LIMIT);
			resyncRequired = true;
		}
	});

	/** Handle discourse.post. */
	async function handlePost(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_POST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, content, author, replyToPostId } = ctx.payload;
		const posted = await service.post({
			schemaVersion: "discourse.command.v1",
			operationId: ctx.toolCallId ?? ctx.correlationId,
			boardId: DEFAULT_BOARD_ID,
			forumId: DEFAULT_FORUM_ID,
			topicId: topic,
			threadId: thread,
			authorId: author ?? DEFAULT_AUTHOR_ID,
			content,
			...(replyToPostId !== undefined ? { replyToPostId } : {}),
		});
		return withDisplay(
			{ posted: true, id: posted.post.id, topic, thread, sequence: posted.post.sequence, replayed: posted.replayed },
			{ text: `Posted to ${topic}/${thread}`, mimeType: "text/plain" },
		);
	}

	/** Handle discourse.read. */
	async function handleRead(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_READ.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, afterSequence } = ctx.payload;
		const page = await service.readThread({
			boardId: DEFAULT_BOARD_ID,
			forumId: DEFAULT_FORUM_ID,
			topicId: topic,
			threadId: thread,
			...(afterSequence !== undefined ? { afterSequence } : {}),
			limit: NATIVE_QUERY_LIMIT,
		});
		return withDisplay(
			{ posts: page.items, count: page.items.length, truncated: page.truncated },
			{ text: page.items.length > 0 ? page.items.map(renderPost).join("\n") : "(no posts)", mimeType: "text/plain" },
		);
	}

	/** Handle discourse.list. */
	async function handleList(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_LIST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic } = ctx.payload;
		if (topic !== undefined) {
			const page = await service.listThreads({
				boardId: DEFAULT_BOARD_ID,
				forumId: DEFAULT_FORUM_ID,
				topicId: topic,
				limit: NATIVE_QUERY_LIMIT,
			});
			return withDisplay(
				{ threads: page.items, truncated: page.truncated },
				{
					text:
						page.items.map((thread) => `${thread.topicId}/${thread.threadId} (${thread.postCount})`).join("\n") ||
						`(no threads in ${topic})`,
					mimeType: "text/plain",
				},
			);
		}
		const page = await service.listTopics({
			boardId: DEFAULT_BOARD_ID,
			forumId: DEFAULT_FORUM_ID,
			limit: NATIVE_QUERY_LIMIT,
		});
		return withDisplay(
			{ topics: page.items, truncated: page.truncated },
			{
				text: page.items.map((t) => `${t.topicId}/ (${t.threadCount})`).join("\n") || "(empty forum)",
				mimeType: "text/plain",
			},
		);
	}

	const contextStage: ContextAssemblyHandler = async (input) => {
		await subscriptionReady;
		let posts: readonly Post[];
		if (resyncRequired) {
			posts = (await service.snapshot({ forumId: DEFAULT_FORUM_ID, limit: NATIVE_QUERY_LIMIT })).posts.items;
			resyncRequired = false;
		} else {
			const events = pendingEvents.splice(0);
			posts = (
				await Promise.all(
					events.map(async (event) => {
						const page = await service.readThread({
							boardId: event.boardId,
							forumId: event.forumId,
							topicId: event.topicId,
							threadId: event.threadId,
							afterSequence: event.sequence - 1,
							limit: 1,
						});
						return page.items[0];
					}),
				)
			).filter((post): post is Post => post !== undefined);
		}
		pendingEvents.splice(0);
		if (posts.length === 0) return {};
		const latest = posts.at(-1);
		if (latest) await service.acknowledge(CONSUMER_ID, latest.sequence);
		const block = `[Forum — ${posts.length} new post(s)]\n${posts.map(renderPost).join("\n")}`;
		return { messages: injectContextBlock(input.messages, block, { source: "discourse" }) };
	};

	return defineAdapter(
		"discourse",
		{
			command: {
				"discourse.post": typedAction(FORUM_POST, handlePost),
				"discourse.read": typedAction(FORUM_READ, handleRead),
				"discourse.list": typedAction(FORUM_LIST, handleList),
			},
		},
		{
			description: "Forum — shared message forum with bounded sequenced delivery for multi-agent coordination.",
			labels: ["discourse", "forum", "multi-agent"],
			directives: [
				"Use discourse for agent-to-agent coordination: sharing findings, asking questions, coordinating reviews, and leaving structured feedback.",
				"Prefer discourse.post over creating files when findings are for other agents. Files are for deliverables; discourse is for collaboration.",
				"Post with discourse.post({topic, thread, content}). Read others' posts with discourse.read({topic, thread}). List topics with discourse.list().",
				"Forum posts auto-inject into context each turn — no polling needed.",
				"This adapter's forum is process-local and in-memory; it does not persist across restarts. Use a connected backend composition for durable, cross-process coordination.",
			],
			sources: [{ name: "in-memory", kind: "process" }],
			contributions: {
				"context.stage": contextStage,
			},
			...opts,
		},
	);
}

export { createDiscourseAdapter as createAdapter };
