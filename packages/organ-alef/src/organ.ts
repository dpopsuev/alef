/**
 * AlefApiOrgan — typed tools for querying the running Alef instance.
 *
 * Replaces the nodesh prelude used in :meta phase 1.
 * The organ is loaded by the in-process meta-agent only — it is never
 * part of the main agent's organ set.
 *
 * ALE-TSK-385 / ALE-SPC-50 phase 2.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionMap } from "@dpopsuev/alef-spine";
import { defineOrgan, typedAction } from "@dpopsuev/alef-spine";
import { z } from "zod";

export interface ScrollAdapter {
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[]; contentPreview: string }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
	replace(id: string, content: string): void;
	add(id: string, priority: number, content: string, tags?: string[]): void;
	remove(id: string): void;
}

export interface AlefApiOrganOptions {
	getScroll?: () => ScrollAdapter | undefined;
}

const SESSION_ROOT = join(homedir(), ".alef", "sessions");
const CONFIG_ROOT = join(homedir(), ".config", "alef");

interface SessionEntry {
	id: string;
	cwdHash: string;
	mtime: string;
	name: string | undefined;
	firstMessage: string;
	contentFingerprint: string;
	eventCount: number;
}

async function parseSession(
	path: string,
): Promise<{ name: string | undefined; firstMessage: string; contentFingerprint: string; eventCount: number }> {
	try {
		const raw = await readFile(path, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		let name: string | undefined;
		let firstMessage = "";
		const contentParts: string[] = [];
		for (const line of lines) {
			try {
				const r = JSON.parse(line) as { bus?: string; type?: string; payload?: { text?: string; name?: string } };
				if (r.bus === "internal" && r.type === "session.name" && typeof r.payload?.name === "string") {
					name = r.payload.name;
				}
				if (r.bus === "sense" && r.type === "dialog.message") {
					const text = (r.payload?.text ?? "").replace(/\n/g, " ");
					if (!firstMessage) firstMessage = text.slice(0, 80);
					if (contentParts.length < 20) contentParts.push(text.slice(0, 200));
				}
			} catch {
				break;
			}
		}
		return { name, firstMessage, contentFingerprint: contentParts.join(" "), eventCount: lines.length };
	} catch {
		return { name: undefined, firstMessage: "", contentFingerprint: "", eventCount: 0 };
	}
}

async function listAllSessions(): Promise<SessionEntry[]> {
	const results: SessionEntry[] = [];
	try {
		const cwdHashes = await readdir(SESSION_ROOT);
		for (const cwdHash of cwdHashes) {
			const dir = join(SESSION_ROOT, cwdHash);
			try {
				const entries = await readdir(dir);
				for (const entry of entries) {
					if (!entry.endsWith(".jsonl")) continue;
					const id = entry.replace(".jsonl", "");
					const path = join(dir, entry);
					try {
						const s = await stat(path);
						const parsed = await parseSession(path);
						results.push({ id, cwdHash, mtime: s.mtime.toISOString(), ...parsed });
					} catch {
						/* skip unreadable */
					}
				}
			} catch {
				/* skip inaccessible */
			}
		}
	} catch {
		/* no sessions dir */
	}
	return results.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function readSessionTurns(id: string, maxTurns = 10): Promise<{ turn: string; type: string }[]> {
	try {
		const cwdHashes = await readdir(SESSION_ROOT);
		for (const cwdHash of cwdHashes) {
			const path = join(SESSION_ROOT, cwdHash, `${id}.jsonl`);
			try {
				const raw = await readFile(path, "utf-8");
				const turns: { turn: string; type: string }[] = [];
				for (const line of raw.split("\n").filter(Boolean)) {
					try {
						const r = JSON.parse(line) as { type?: string; payload?: { text?: string } };
						if (r.type === "dialog.message") {
							const text = r.payload?.text ?? "";
							if (text) turns.push({ turn: text.slice(0, 200), type: "message" });
							if (turns.length >= maxTurns) break;
						}
					} catch {
						break;
					}
				}
				return turns;
			} catch {
				/* not in this cwdHash */
			}
		}
	} catch {
		/* no sessions */
	}
	return [];
}

async function renameSession(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const cwdHashes = await readdir(SESSION_ROOT);
		for (const cwdHash of cwdHashes) {
			const path = join(SESSION_ROOT, cwdHash, `${id}.jsonl`);
			try {
				await stat(path);
				const record = JSON.stringify({
					bus: "internal",
					type: "session.name",
					correlationId: "meta",
					payload: { name },
					timestamp: Date.now(),
				});
				const { appendFile } = await import("node:fs/promises");
				await appendFile(path, `${record}\n`, "utf-8");
				return { ok: true };
			} catch {
				/* not in this cwdHash */
			}
		}
		return { ok: false, error: `Session '${id}' not found` };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

async function searchSessions(
	query: string,
): Promise<Array<{ id: string; mtime: string; name: string | undefined; snippet: string }>> {
	const all = await listAllSessions();
	const lower = query.toLowerCase();
	return all
		.filter((s) => {
			const haystack = `${s.name ?? ""} ${s.firstMessage} ${s.contentFingerprint}`.toLowerCase();
			return haystack.includes(lower);
		})
		.map((s) => ({
			id: s.id,
			mtime: s.mtime,
			name: s.name,
			snippet: s.name ? `${s.name} — ${s.firstMessage}` : s.firstMessage,
		}));
}

async function getConfig(): Promise<Record<string, unknown>> {
	try {
		const path = join(CONFIG_ROOT, "config.yaml");
		const raw = await readFile(path, "utf-8");
		return { raw };
	} catch {
		return { raw: "(no config file)" };
	}
}

async function listOrgans(): Promise<string[]> {
	try {
		const path = join(CONFIG_ROOT, "organs.yaml");
		const raw = await readFile(path, "utf-8");
		return [raw];
	} catch {
		return ["(organs.yaml not found)"];
	}
}

async function pmHistory(): Promise<Array<{ id: number; ts: string; organs: Record<string, string> }>> {
	try {
		const genDir = join(CONFIG_ROOT, "generations");
		const files = await readdir(genDir);
		const entries = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => {
					const raw = await readFile(join(genDir, f), "utf-8");
					const gen = JSON.parse(raw) as { id: number; ts: string; lockfileContent: string };
					const organs: Record<string, string> = {};
					try {
						const lock = JSON.parse(gen.lockfileContent) as { packages?: Record<string, { version?: string }> };
						for (const [k, v] of Object.entries(lock.packages ?? {})) {
							if (k.startsWith("node_modules/")) organs[k.slice("node_modules/".length)] = v.version ?? "?";
						}
					} catch {
						/* no lockfile */
					}
					return { id: gen.id, ts: gen.ts, organs };
				}),
		);
		return entries.sort((a, b) => b.id - a.id);
	} catch {
		return [];
	}
}

export function createAlefApiOrgan(opts: AlefApiOrganOptions = {}) {
	const g = opts.getScroll;
	const scrollTools: ActionMap = g
		? {
				"motor/alef.scroll.list": typedAction(
					{
						name: "alef.scroll.list",
						description:
							"List all prompt scroll blocks with id, priority, enabled state, tags, and content preview.",
						inputSchema: z.object({}),
					},
					async () => ({ blocks: g()?.list() ?? [] }),
				),
				"motor/alef.scroll.enable": typedAction(
					{
						name: "alef.scroll.enable",
						description: "Enable a prompt scroll block.",
						inputSchema: z.object({ id: z.string() }),
					},
					async (ctx) => {
						g()?.enable(ctx.payload.id);
						return { ok: true };
					},
				),
				"motor/alef.scroll.disable": typedAction(
					{
						name: "alef.scroll.disable",
						description: "Disable a prompt scroll block.",
						inputSchema: z.object({ id: z.string() }),
					},
					async (ctx) => {
						g()?.disable(ctx.payload.id);
						return { ok: true };
					},
				),
				"motor/alef.scroll.toggle": typedAction(
					{
						name: "alef.scroll.toggle",
						description: "Toggle a prompt scroll block on or off.",
						inputSchema: z.object({ id: z.string() }),
					},
					async (ctx) => {
						g()?.toggle(ctx.payload.id);
						return { ok: true };
					},
				),
				"motor/alef.scroll.replace": typedAction(
					{
						name: "alef.scroll.replace",
						description: "Replace the content of a prompt scroll block.",
						inputSchema: z.object({ id: z.string(), content: z.string() }),
					},
					async (ctx) => {
						g()?.replace(ctx.payload.id, ctx.payload.content);
						return { ok: true };
					},
				),
				"motor/alef.scroll.add": typedAction(
					{
						name: "alef.scroll.add",
						description: "Add a new block to the prompt scroll.",
						inputSchema: z.object({
							id: z.string(),
							priority: z.number(),
							content: z.string(),
							tags: z.array(z.string()).optional(),
						}),
					},
					async (ctx) => {
						g()?.add(ctx.payload.id, ctx.payload.priority, ctx.payload.content, ctx.payload.tags);
						return { ok: true };
					},
				),
				"motor/alef.scroll.remove": typedAction(
					{
						name: "alef.scroll.remove",
						description: "Remove a block from the prompt scroll.",
						inputSchema: z.object({ id: z.string() }),
					},
					async (ctx) => {
						g()?.remove(ctx.payload.id);
						return { ok: true };
					},
				),
			}
		: {};

	return defineOrgan(
		"alef",
		{
			...scrollTools,
			"motor/alef.sessions.list": typedAction(
				{
					name: "alef.sessions.list",
					description: "List all Alef sessions across all working directories, newest first.",
					inputSchema: z.object({}),
				},
				async () => ({ sessions: await listAllSessions() }),
				{ shouldCache: () => false },
			),
			"motor/alef.sessions.search": typedAction(
				{
					name: "alef.sessions.search",
					description: "Search sessions by keyword across name, first message, and conversation content.",
					inputSchema: z.object({ query: z.string().describe("Keyword or phrase to search for") }),
				},
				async (ctx) => ({ results: await searchSessions(ctx.payload.query) }),
			),
			"motor/alef.sessions.rename": typedAction(
				{
					name: "alef.sessions.rename",
					description: "Give a session a human-readable name so it can be found later.",
					inputSchema: z.object({
						id: z.string().describe("8-char session ID"),
						name: z.string().describe("Concise descriptive name, e.g. 'ToolShell eval and amnesia fix'"),
					}),
				},
				async (ctx) => renameSession(ctx.payload.id, ctx.payload.name),
			),
			"motor/alef.sessions.read": typedAction(
				{
					name: "alef.sessions.read",
					description: "Read the first N turns of a session by ID.",
					inputSchema: z.object({
						id: z.string().describe("8-char session ID"),
						maxTurns: z.number().optional().default(10).describe("Max turns to return (default 10)"),
					}),
				},
				async (ctx) => ({ turns: await readSessionTurns(ctx.payload.id, ctx.payload.maxTurns) }),
			),
			"motor/alef.config.get": typedAction(
				{
					name: "alef.config.get",
					description: "Get the current Alef config from ~/.config/alef/config.yaml.",
					inputSchema: z.object({}),
				},
				async () => ({ config: await getConfig() }),
				{ shouldCache: () => true },
			),
			"motor/alef.organs.list": typedAction(
				{
					name: "alef.organs.list",
					description: "List user-installed organs from ~/.config/alef/organs.yaml.",
					inputSchema: z.object({}),
				},
				async () => ({ organs: await listOrgans() }),
				{ shouldCache: () => true },
			),
			"motor/alef.pm.history": typedAction(
				{
					name: "alef.pm.history",
					description: "List organ package manager generation history.",
					inputSchema: z.object({}),
				},
				async () => ({ history: await pmHistory() }),
				{ shouldCache: () => true },
			),
		},

		{
			description: "Query Alef sessions, config, organs, package manager history, and manage the prompt scroll.",
			directives: [
				"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic — it searches name, first message, and content. " +
					"Use alef.sessions.read to get the content of a specific session. " +
					"Use alef.sessions.rename to give a session a memorable name when asked. " +
					"Use alef.config.get, alef.organs.list, alef.pm.history for system information. " +
					"Use alef.scroll.list to show the active prompt blocks. Use alef.scroll.enable/disable/toggle to change which blocks are active. " +
					"Use alef.scroll.replace to change block content. Use alef.scroll.add to inject a new block. " +
					"Respond concisely with the most relevant data. Do not write files.",
			],
			labels: ["alef-api", "meta", "sessions", "scroll"],
		},
	);
}
