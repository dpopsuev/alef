import type { Adapter, BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { z } from "zod";
import { scribeCallFromEnv } from "./http-scribe-call.js";
import type { DiscourseBackend, ScribeArtifactCall } from "./scribe-backend.js";
import { ScribeDiscourseBackend } from "./scribe-backend.js";
import { DiscourseStore } from "./store.js";
import type { Post } from "./types.js";

/**
 *
 */
export interface DiscourseAdapterOptions extends BaseAdapterOptions {
	sessionDir: string;
	actorAddress?: string;
	/** When set, posts go to Scribe via message_add (JSONL is not SoR). */
	scribeCall?: ScribeArtifactCall;
	/** Scope stamp for Scribe-backed containers (default: default). */
	scope?: string;
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

/** Find questions without matching answers, optionally filtered by target @address. */
async function findUnansweredQuestions(store: DiscourseBackend, actorAddress?: string): Promise<Post[]> {
	const allPosts = await store.readNewPosts(0);
	const questions = new Map<string, Post>();
	const answered = new Set<string>();

	for (const post of allPosts) {
		if (typeof post.content === "object" && post.content !== null) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- content is validated as object above
			const c = post.content as Record<string, unknown>;
			if (c.type === "question" && typeof c.responseId === "string") {
				if (!actorAddress || !c.target || c.target === actorAddress) {
					questions.set(c.responseId, post);
				}
			} else if (c.type === "answer" && typeof c.responseId === "string") {
				answered.add(c.responseId);
			}
		}
	}

	return [...questions.entries()]
		.filter(([id]) => !answered.has(id))
		.map(([, post]) => post);
}

/**
 * Resolve backend storage implementation.
 */
function resolveBackend(opts: DiscourseAdapterOptions): DiscourseBackend {
	const call = opts.scribeCall ?? scribeCallFromEnv();
	if (call) {
		return new ScribeDiscourseBackend(call, opts.scope ?? "default");
	}
	return new DiscourseStore(opts.sessionDir);
}

/** Create the discourse adapter with forum tools and question-aware context injection. */
export function createDiscourseAdapter(opts: DiscourseAdapterOptions): Adapter {
	const store = resolveBackend(opts);
	let lastReadTs = Date.now();

	const contextStage: ContextAssemblyHandler = async (input) => {
		const newPosts = await store.readNewPosts(lastReadTs);
		const blocks: string[] = [];

		if (newPosts.length > 0) {
			lastReadTs = Math.max(...newPosts.map((p) => p.timestamp));
			blocks.push(`[Forum — ${newPosts.length} new post(s)]\n${newPosts.map(formatContextPost).join("\n")}`);
		}

		const unanswered = await findUnansweredQuestions(store, opts.actorAddress);
		if (unanswered.length > 0) {
			blocks.push(`[QUESTIONS — ${unanswered.length} unanswered]\n${unanswered.map((q) => `[${q.topic}/${q.thread}] @${q.author}: ${typeof q.content === "object" && q.content !== null && "text" in q.content ? String((q.content as Record<string, unknown>).text) : String(q.content)}`).join("\n")}`);
		}

		if (blocks.length === 0) return {};
		return { messages: injectContextBlock(input.messages, blocks.join("\n\n"), { source: "discourse" }) };
	};

	/** Handle discourse.post. */
	async function handlePost(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_POST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, content, author } = ctx.payload;
		const post = await store.append(topic, thread, author ?? opts.actorAddress ?? "agent", content);
		return withDisplay(
			{ posted: true, topic, thread, timestamp: post.timestamp },
			{ text: `Posted to ${topic}/${thread}`, mimeType: "text/plain" },
		);
	}

	/** Handle discourse.read. */
	async function handleRead(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_READ.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, since } = ctx.payload;
		const posts = await store.readThread(topic, thread, since);
		return withDisplay(
			{ posts, count: posts.length },
			{ text: posts.length > 0 ? posts.map(formatPost).join("\n") : "(no posts)", mimeType: "text/plain" },
		);
	}

	/** Handle discourse.list. */
	async function handleList(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_LIST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic } = ctx.payload;
		if (topic) {
			const threadNames = await store.listThreads(topic);
			const infos = await Promise.all(threadNames.map(async (name) => store.threadInfo(topic, name)));
			return withDisplay(
				{ topic, threads: infos },
				{
					text:
						infos.length > 0
							? infos
									.map((info) => `  ${topic}/${info.name} (${info.posts} posts, ${info.participants.join(", ")})`)
									.join("\n")
							: `(no threads in ${topic})`,
					mimeType: "text/plain",
				},
			);
		}
		const summaries = await store.topicSummaries();
		const lines = summaries.flatMap((s) => [`${s.topic}/`, ...s.threads.map((name) => `  ${name}`)]);
		return withDisplay(
			{ topics: summaries },
			{ text: lines.length > 0 ? lines.join("\n") : "(empty forum)", mimeType: "text/plain" },
		);
	}

	const usingScribe = Boolean(opts.scribeCall ?? process.env.SCRIBE_URL?.trim());
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
				"Use discourse for agent-to-agent coordination: sharing findings, asking questions, coordinating reviews, and leaving structured feedback. Discourse is for communication between agents.",
				"Prefer discourse.post over creating files when findings are for other agents. Files are for deliverables; discourse is for collaboration.",
				"Post with discourse.post({topic, thread, content}). Read others' posts with discourse.read({topic, thread}). List topics with discourse.list().",
				"Forum posts auto-inject into context each turn - no polling needed.",
				...(usingScribe
					? ["Persistence is Scribe (message_add under knowledge.context). [[wikilinks]] in posts auto-link in the vault."]
					: []),
			],
			sources: [{ name: usingScribe ? "scribe" : "discourse-files", kind: usingScribe ? "process" : "file" }],
			contributions: {
				"context.assemble": contextStage,
			},
			...opts,
		},
	);
}
