import { randomUUID } from "node:crypto";
import { InMemoryDiscourseStore, InMemoryDiscourseSubscriptions } from "@dpopsuev/discourse-capability/memory-store";
import { DiscourseService } from "@dpopsuev/discourse-capability/service";
import type { DiscourseEvent, Post } from "@dpopsuev/discourse-capability/types";
import { Type } from "typebox";
import { DEFAULT_AUTHOR_ID, DEFAULT_FORUM_ID, NATIVE_EVENT_LIMIT, NATIVE_QUERY_LIMIT } from "./constants.js";
import type { NativeExtensionApi, NativeToolResult } from "./contracts.js";

const CONSUMER_ID = "pi-adapter";

/** Return a native text result with stable machine details. */
function result(text: string, details: Record<string, unknown>): NativeToolResult {
	return { content: [{ type: "text", text }], details };
}
/** Require one string parameter after host schema validation. */
function stringParameter(params: Record<string, unknown>, name: string): string {
	const value = params[name];
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}
/** Render one post for human context without changing its machine DTO. */
function renderPost(post: Post): string {
	const body = typeof post.content === "string" ? post.content : JSON.stringify(post.content);
	return `[${post.topicId}/${post.threadId}] @${post.authorId}: ${body}`;
}

/** Register native tools and sequenced context delivery. */
export default function registerDiscourse(pi: NativeExtensionApi): void {
	const store = new InMemoryDiscourseStore();
	const service = new DiscourseService({
		store,
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

	pi.registerTool({
		name: "discourse_post",
		label: "Discourse post",
		description: "Append one idempotent forum post or reply.",
		parameters: Type.Object({
			topic: Type.String({ minLength: 1 }),
			thread: Type.String({ minLength: 1 }),
			content: Type.Unknown(),
			author: Type.Optional(Type.String({ minLength: 1 })),
			replyToPostId: Type.Optional(Type.String({ minLength: 1 })),
		}),
		async execute(callId, params) {
			const posted = await service.post({
				schemaVersion: "discourse.command.v1",
				operationId: callId,
				forumId: DEFAULT_FORUM_ID,
				topicId: stringParameter(params, "topic"),
				threadId: stringParameter(params, "thread"),
				authorId: typeof params.author === "string" ? params.author : DEFAULT_AUTHOR_ID,
				content: params.content,
				...(typeof params.replyToPostId === "string" ? { replyToPostId: params.replyToPostId } : {}),
			});
			return result(`Posted to ${posted.post.topicId}/${posted.post.threadId}`, { posted });
		},
	});

	pi.registerTool({
		name: "discourse_read",
		label: "Discourse read",
		description: "Read one bounded forum thread page.",
		parameters: Type.Object({
			topic: Type.String({ minLength: 1 }),
			thread: Type.String({ minLength: 1 }),
			afterSequence: Type.Optional(Type.Number({ minimum: 0 })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: NATIVE_QUERY_LIMIT })),
		}),
		async execute(_callId, params) {
			const page = await service.readThread({
				forumId: DEFAULT_FORUM_ID,
				topicId: stringParameter(params, "topic"),
				threadId: stringParameter(params, "thread"),
				...(typeof params.afterSequence === "number" ? { afterSequence: params.afterSequence } : {}),
				limit: typeof params.limit === "number" ? params.limit : NATIVE_QUERY_LIMIT,
			});
			return result(page.items.length > 0 ? page.items.map(renderPost).join("\n") : "(no posts)", { page });
		},
	});

	pi.registerTool({
		name: "discourse_list",
		label: "Discourse list",
		description: "List bounded forum topics or threads.",
		parameters: Type.Object({ topic: Type.Optional(Type.String({ minLength: 1 })) }),
		async execute(_callId, params) {
			if (typeof params.topic === "string") {
				const page = await service.listThreads({
					forumId: DEFAULT_FORUM_ID,
					topicId: params.topic,
					limit: NATIVE_QUERY_LIMIT,
				});
				return result(
					page.items.map((thread) => `${thread.topicId}/${thread.threadId} (${thread.postCount})`).join("\n") ||
						"(no threads)",
					{ page },
				);
			}
			const page = await service.listTopics({ forumId: DEFAULT_FORUM_ID, limit: NATIVE_QUERY_LIMIT });
			return result(
				page.items.map((topic) => `${topic.topicId}/ (${topic.threadCount})`).join("\n") || "(empty forum)",
				{ page },
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		await subscriptionReady;
		let posts: readonly Post[];
		if (resyncRequired) {
			posts = (await service.snapshot({ forumId: DEFAULT_FORUM_ID, limit: NATIVE_QUERY_LIMIT })).posts.items;
			resyncRequired = false;
		} else {
			const events = pendingEvents.splice(0);
			posts = (
				await Promise.all(
					events.map(async (item) => {
						const page = await service.readThread({
							forumId: item.forumId,
							topicId: item.topicId,
							threadId: item.threadId,
							afterSequence: item.sequence - 1,
							limit: 1,
						});
						return page.items[0];
					}),
				)
			).filter((post): post is Post => post !== undefined);
		}
		pendingEvents.splice(0);
		if (posts.length === 0) return undefined;
		const latest = posts.at(-1);
		if (latest) await service.acknowledge(CONSUMER_ID, latest.sequence);
		const block = `[Forum — ${posts.length} new post(s)]\n${posts.map(renderPost).join("\n")}`;
		return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${block}` };
	});
}
