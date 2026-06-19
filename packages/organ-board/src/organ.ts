import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseOrganOptions, ContextAssemblyHandler, Organ } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface BoardOrganOptions extends BaseOrganOptions {
	sessionDir: string;
}

interface Post {
	key: string;
	author: string;
	content: unknown;
	ts: number;
}

function boardDir(sessionDir: string): string {
	return join(sessionDir, "board");
}

function threadPath(sessionDir: string, topic: string, thread: string): string {
	return join(boardDir(sessionDir), topic, `${thread}.jsonl`);
}

function ensureDir(path: string): void {
	const dir = path.substring(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
}

function appendPost(sessionDir: string, topic: string, thread: string, post: Post): void {
	const path = threadPath(sessionDir, topic, thread);
	ensureDir(path);
	appendFileSync(path, `${JSON.stringify(post)}\n`, "utf-8");
}

function readThread(sessionDir: string, topic: string, thread: string, since?: number): Post[] {
	const path = threadPath(sessionDir, topic, thread);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
	const posts: Post[] = [];
	for (const line of lines) {
		try {
			const post = JSON.parse(line) as Post;
			if (since && post.ts <= since) continue;
			posts.push(post);
		} catch {
			// skip malformed lines
		}
	}
	return posts;
}

function listTopics(sessionDir: string): string[] {
	const dir = boardDir(sessionDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

function listThreads(sessionDir: string, topic: string): string[] {
	const dir = join(boardDir(sessionDir), topic);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => f.replace(".jsonl", ""));
}

function readAllNewPosts(sessionDir: string, lastReadTs: number): Array<Post & { topic: string; thread: string }> {
	const results: Array<Post & { topic: string; thread: string }> = [];
	for (const topic of listTopics(sessionDir)) {
		for (const thread of listThreads(sessionDir, topic)) {
			for (const post of readThread(sessionDir, topic, thread, lastReadTs)) {
				results.push({ ...post, topic, thread });
			}
		}
	}
	return results.sort((a, b) => a.ts - b.ts);
}

const BOARD_POST_TOOL = {
	name: "board.post",
	description: "Post a message to a board topic/thread. Append-only — safe for concurrent writers.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name (e.g. 'collectors', 'reviews', 'findings')"),
		thread: z.string().min(1).describe("Thread name within the topic (e.g. 'long-functions', 'nesting')"),
		content: z.unknown().describe("Message content — any JSON-serializable value"),
		author: z.string().optional().describe("Author name (defaults to agent identity)"),
	}),
};

const BOARD_READ_TOOL = {
	name: "board.read",
	description: "Read posts from a board thread. Returns all posts, or posts since a timestamp.",
	inputSchema: z.object({
		topic: z.string().min(1).describe("Topic name"),
		thread: z.string().min(1).describe("Thread name"),
		since: z.number().optional().describe("Only return posts after this Unix timestamp (ms)"),
	}),
};

const BOARD_LIST_TOOL = {
	name: "board.list",
	description: "List board topics and threads.",
	inputSchema: z.object({
		topic: z.string().optional().describe("List threads in this topic. Omit to list all topics."),
	}),
};

export function createBoardOrgan(opts: BoardOrganOptions): Organ {
	const { sessionDir } = opts;
	let lastReadTs = Date.now();

	const contextStage: ContextAssemblyHandler = async (input) => {
		const newPosts = readAllNewPosts(sessionDir, lastReadTs);
		if (newPosts.length === 0) return {};

		lastReadTs = Math.max(...newPosts.map((p) => p.ts));
		const lines = newPosts.map(
			(p) =>
				`[${p.topic}/${p.thread}] @${p.author}: ${typeof p.content === "string" ? p.content : JSON.stringify(p.content)}`,
		);
		const block = `[Board — ${newPosts.length} new post(s)]\n${lines.join("\n")}`;

		const messages = [...input.messages];
		const systemIdx = messages.findIndex((m) => (m as { role?: string }).role === "system");
		const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
		messages.splice(insertAt, 0, { role: "user", content: block });

		return { messages };
	};

	return defineOrgan(
		"board",
		{
			motor: {
				"board.post": typedAction(BOARD_POST_TOOL, async (ctx) => {
					const { topic, thread, content, author } = ctx.payload;
					const post: Post = {
						key: `${topic}/${thread}`,
						author: (author as string) ?? "agent",
						content,
						ts: Date.now(),
					};
					appendPost(sessionDir, topic as string, thread as string, post);

					return withDisplay(
						{ posted: true, topic, thread, ts: post.ts },
						{ text: `Posted to ${topic}/${thread}`, mimeType: "text/plain" },
					);
				}),

				"board.read": typedAction(BOARD_READ_TOOL, async (ctx) => {
					const { topic, thread, since } = ctx.payload;
					const posts = readThread(sessionDir, topic as string, thread as string, since as number | undefined);
					const lines = posts.map(
						(p) =>
							`@${p.author} (${new Date(p.ts).toISOString().slice(11, 19)}): ${typeof p.content === "string" ? p.content : JSON.stringify(p.content)}`,
					);
					return withDisplay(
						{ posts, count: posts.length },
						{ text: lines.length > 0 ? lines.join("\n") : "(no posts)", mimeType: "text/plain" },
					);
				}),

				"board.list": typedAction(BOARD_LIST_TOOL, async (ctx) => {
					const { topic } = ctx.payload;
					if (topic) {
						const threads = listThreads(sessionDir, topic as string);
						return withDisplay(
							{ topic, threads },
							{
								text:
									threads.length > 0
										? threads.map((t) => `  ${topic}/${t}`).join("\n")
										: `(no threads in ${topic})`,
								mimeType: "text/plain",
							},
						);
					}
					const topics = listTopics(sessionDir);
					const result: Array<{ topic: string; threads: string[] }> = topics.map((t) => ({
						topic: t,
						threads: listThreads(sessionDir, t),
					}));
					const lines = result.flatMap((r) => [`${r.topic}/`, ...r.threads.map((t) => `  ${t}`)]);
					return withDisplay(
						{ topics: result },
						{ text: lines.length > 0 ? lines.join("\n") : "(empty board)", mimeType: "text/plain" },
					);
				}),
			},
		},
		{
			description: "Board — shared message board for multi-agent coordination. Pull-based: agents read when ready.",
			directives: [
				"Use board.post to share findings, reviews, and feedback with other agents.",
				"Use board.read to check what others have posted.",
				"New board posts appear automatically in your context on each turn.",
			],
			sources: [{ name: "board-files", kind: "file" }],
			contributions: {
				"context.assemble": contextStage,
			},
			...opts,
		},
	);
}
