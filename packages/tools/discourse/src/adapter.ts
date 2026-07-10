import type { Adapter, BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { z } from "zod";
import { DiscourseStore } from "./store.js";
import type { Post } from "./types.js";

/**
 *
 */
export interface DiscourseAdapterOptions extends BaseAdapterOptions {
	sessionDir: string;
	actorAddress?: string;
}

const FORUM_POST = {
	name: "discourse.post",
	description: "Post a message to a forum topic/thread. Append-only — safe for concurrent writers.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name (e.g. 'collectors', 'reviews', 'findings')"),
		thread: z.string().min(1).describe("Thread name within the topic (e.g. 'long-functions', 'nesting')"),
		content: z.unknown().describe("Message content — any JSON-serializable value"),
		author: z.string().optional().describe("Author name (defaults to agent identity)"),
	}),
};

const FORUM_READ = {
	name: "discourse.read",
	description: "Read posts from a forum thread. Returns all posts, or posts since a timestamp.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name"),
		thread: z.string().min(1).describe("Thread name"),
		since: z.number().optional().describe("Only return posts after this Unix timestamp (ms)"),
	}),
};

const FORUM_LIST = {
	name: "discourse.list",
	description: "List forum topics and threads with metadata.",
	inputSchema: z.object({
		topic: z.string().optional().describe("List threads in this topic. Omit to list all topics."),
	}),
};

/**
 *
 */
function formatPost(p: Post): string {
	const body = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
	return `@${p.author} (${new Date(p.timestamp).toISOString().slice(11, 19)}): ${body}`;
}

/**
 *
 */
function formatContextPost(p: Post): string {
	const body = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
	return `[${p.topic}/${p.thread}] @${p.author}: ${body}`;
}

/**
 *
 */
export function createDiscourseAdapter(opts: DiscourseAdapterOptions): Adapter {
	const store = new DiscourseStore(opts.sessionDir);
	let lastReadTs = Date.now();

	// eslint-disable-next-line @typescript-eslint/require-await
	const contextStage: ContextAssemblyHandler = async (input) => {
		const newPosts = store.readNewPosts(lastReadTs);
		if (newPosts.length === 0) return {};

		lastReadTs = Math.max(...newPosts.map((p) => p.timestamp));
		const block = `[Forum — ${newPosts.length} new post(s)]\n${newPosts.map(formatContextPost).join("\n")}`;
		return { messages: injectContextBlock(input.messages, block) };
	};

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handlePost(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_POST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, content, author } = ctx.payload;
		const post = store.append(topic, thread, author ?? opts.actorAddress ?? "agent", content);
		return withDisplay(
			{ posted: true, topic, thread, timestamp: post.timestamp },
			{ text: `Posted to ${topic}/${thread}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleRead(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_READ.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, since } = ctx.payload;
		const posts = store.readThread(topic, thread, since);
		return withDisplay(
			{ posts, count: posts.length },
			{ text: posts.length > 0 ? posts.map(formatPost).join("\n") : "(no posts)", mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleList(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_LIST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic } = ctx.payload;
		if (topic) {
			const infos = store.listThreads(topic).map((t) => store.threadInfo(topic, t));
			return withDisplay(
				{ topic, threads: infos },
				{
					text:
						infos.length > 0
							? infos
									.map((t) => `  ${topic}/${t.name} (${t.posts} posts, ${t.participants.join(", ")})`)
									.join("\n")
							: `(no threads in ${topic})`,
					mimeType: "text/plain",
				},
			);
		}
		const summaries = store.topicSummaries();
		const lines = summaries.flatMap((s) => [`${s.topic}/`, ...s.threads.map((t) => `  ${t}`)]);
		return withDisplay(
			{ topics: summaries },
			{ text: lines.length > 0 ? lines.join("\n") : "(empty forum)", mimeType: "text/plain" },
		);
	}

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
			description: "Forum — shared message forum for multi-agent coordination. Pull-based: agents read when ready.",
			labels: ["discourse", "forum", "multi-agent", "experimental"],
			directives: [
				"Use discourse.post to share findings, reviews, and feedback with other agents.",
				"Use discourse.read to check what others have posted.",
				"New forum posts appear automatically in your context on each turn.",
			],
			sources: [{ name: "discourse-files", kind: "file" }],
			contributions: {
				"context.assemble": contextStage,
			},
			...opts,
		},
	);
}
