import type { Adapter, BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import type { DiscourseBackend } from "./backend.js";
import { CapabilityDiscourseBackend } from "./capability-backend.js";
import { openInMemoryDiscourseBackend } from "./open-backend.js";
import type { ScribeArtifactCall } from "./scribe-projection.js";
import type { Post } from "./types.js";

/**
 *
 */
export interface DiscourseAdapterOptions extends BaseAdapterOptions {
	/** Injected backend (preferred). */
	backend?: DiscourseBackend;
	actorAddress?: string;
	ignoredThread?: { topic: string; thread: string };
	/** When set (or SCRIBE_URL), wrap the store with a Scribe mirror. */
	scribeCall?: ScribeArtifactCall;
	/** Scope stamp for Scribe mirror containers (default: default). */
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
		replyToPostId: z.string().optional().describe("Reply to this existing post id within the same thread"),
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

	return [...questions.entries()].filter(([id]) => !answered.has(id)).map(([, post]) => post);
}

/** Resolve exactly one capability-backed mutation authority. */
function resolveBackend(opts: DiscourseAdapterOptions): CapabilityDiscourseBackend {
	const store =
		opts.backend ??
		openInMemoryDiscourseBackend({ scribeCall: opts.scribeCall, scope: opts.scope, logger: opts.logger });
	if (!(store instanceof CapabilityDiscourseBackend))
		throw new Error("Discourse adapter requires a capability-backed store");
	return store;
}

/** Create the discourse adapter with forum tools and question-aware context injection. */
export function createDiscourseAdapter(opts: DiscourseAdapterOptions): Adapter {
	const store = resolveBackend(opts);

	const contextStage: ContextAssemblyHandler = async (input) => {
		const newPosts = await store.readPendingPosts();
		const blocks: string[] = [];
		const ignoredThread = opts.ignoredThread;
		const visiblePosts = ignoredThread
			? newPosts.filter((post) => !(post.topic === ignoredThread.topic && post.thread === ignoredThread.thread))
			: newPosts;

		if (visiblePosts.length > 0) {
			blocks.push(`[Forum — ${visiblePosts.length} new post(s)]\n${visiblePosts.map(formatContextPost).join("\n")}`);
		}

		const unanswered = await findUnansweredQuestions(store, opts.actorAddress);
		if (unanswered.length > 0) {
			blocks.push(
				`[QUESTIONS — ${unanswered.length} unanswered]\n${unanswered.map((q) => `[${q.topic}/${q.thread}] @${q.author}: ${typeof q.content === "object" && q.content !== null && "text" in q.content ? String((q.content as Record<string, unknown>).text) : String(q.content)}`).join("\n")}`,
			);
		}

		if (blocks.length === 0) return {};
		return { messages: injectContextBlock(input.messages, blocks.join("\n\n"), { source: "discourse" }) };
	};

	/** Handle discourse.post. */
	async function handlePost(
		ctx: CommandHandlerCtx<z.infer<typeof FORUM_POST.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { topic, thread, content, author, replyToPostId } = ctx.payload;
		const post = await store.append(topic, thread, author ?? opts.actorAddress ?? "agent", content, {
			replyToPostId,
			operationId: ctx.toolCallId ?? ctx.correlationId,
			correlationId: ctx.correlationId,
		});
		return withDisplay(
			{ posted: true, id: post.id, topic, thread, timestamp: post.timestamp, replyToPostId: post.replyToPostId },
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
									.map(
										(info) =>
											`  ${topic}/${info.name} (${info.posts} posts, ${info.participants.join(", ")})`,
									)
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
			description: "Forum — shared message forum with bounded sequenced delivery for multi-agent coordination.",
			labels: ["discourse", "forum", "multi-agent", "experimental"],
			directives: [
				"Use discourse for agent-to-agent coordination: sharing findings, asking questions, coordinating reviews, and leaving structured feedback. Discourse is for communication between agents.",
				"Prefer discourse.post over creating files when findings are for other agents. Files are for deliverables; discourse is for collaboration.",
				"Post with discourse.post({topic, thread, content}). Read others' posts with discourse.read({topic, thread}). List topics with discourse.list().",
				"Forum posts auto-inject into context each turn - no polling needed.",
				...(usingScribe
					? [
							"Discourse commits posts and projection outbox records atomically; Scribe receives an idempotent checkpointed view with observable lag.",
						]
					: ["Discourse posts persist in the Alef session store."]),
			],
			sources: [{ name: usingScribe ? "session-store+scribe" : "session-store", kind: "process" }],
			contributions: {
				"context.assemble": contextStage,
			},
			...opts,
		},
	);
}
