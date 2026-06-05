/**
 * AlefApiOrgan — typed tools for querying the running Alef instance.
 *
 * Replaces the nodesh prelude used in :meta phase 1.
 * The organ is loaded by the in-process meta-agent only — it is never
 * part of the main agent's organ set.
 *
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionMap } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface DirectiveAdapter {
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[]; contentPreview: string }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
	replace(id: string, content: string): void;
	add(id: string, priority: number, content: string, tags?: string[]): void;
	remove(id: string): void;
}

export interface AlefApiOrganOptions {
	getDirective?: () => DirectiveAdapter | undefined;
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
	const g = opts.getDirective;
	const promptTools: ActionMap = g
		? {
				"motor/alef.directive.list": typedAction(
					{
						name: "alef.directive.list",
						description:
							"List all system prompt blocks with id, priority, enabled state, tags, and content preview.",
						inputSchema: z.object({}),
					},
					async () => {
						const blocks = g()?.list() ?? [];
						return withDisplay(
							{ blocks },
							{ text: `${blocks.length} directive block(s)`, mimeType: "text/plain" },
						);
					},
				),
				"motor/alef.directive.enable": typedAction(
					{
						name: "alef.directive.enable",
						description: "Enable a system prompt block.",
						inputSchema: z.object({ id: z.string().min(1) }),
					},
					async (ctx) => {
						g()?.enable(ctx.payload.id);
						return withDisplay(
							{ ok: true },
							{ text: `Enabled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
						);
					},
				),
				"motor/alef.directive.disable": typedAction(
					{
						name: "alef.directive.disable",
						description: "Disable a system prompt block.",
						inputSchema: z.object({ id: z.string().min(1) }),
					},
					async (ctx) => {
						g()?.disable(ctx.payload.id);
						return withDisplay(
							{ ok: true },
							{ text: `Disabled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
						);
					},
				),
				"motor/alef.directive.toggle": typedAction(
					{
						name: "alef.directive.toggle",
						description: "Toggle a system prompt block on or off.",
						inputSchema: z.object({ id: z.string().min(1) }),
					},
					async (ctx) => {
						g()?.toggle(ctx.payload.id);
						return withDisplay(
							{ ok: true },
							{ text: `Toggled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
						);
					},
				),
				"motor/alef.directive.replace": typedAction(
					{
						name: "alef.directive.replace",
						description: "Replace the content of a system prompt block.",
						inputSchema: z.object({ id: z.string().min(1), content: z.string().min(1) }),
					},
					async (ctx) => {
						g()?.replace(ctx.payload.id, ctx.payload.content);
						return withDisplay(
							{ ok: true },
							{ text: `Replaced directive: ${ctx.payload.id}`, mimeType: "text/plain" },
						);
					},
				),
				"motor/alef.directive.add": typedAction(
					{
						name: "alef.directive.add",
						description: "Add a new block to the system prompt.",
						inputSchema: z.object({
							id: z.string().min(1),
							priority: z.number(),
							content: z.string().min(1),
							tags: z.array(z.string()).optional(),
						}),
					},
					async (ctx) => {
						g()?.add(ctx.payload.id, ctx.payload.priority, ctx.payload.content, ctx.payload.tags);
						return withDisplay(
							{ ok: true },
							{
								text: `Added directive: ${ctx.payload.id} (priority ${ctx.payload.priority})`,
								mimeType: "text/plain",
							},
						);
					},
				),
				"motor/alef.directive.remove": typedAction(
					{
						name: "alef.directive.remove",
						description: "Remove a block from the prompt scroll.",
						inputSchema: z.object({ id: z.string().min(1) }),
					},
					async (ctx) => {
						g()?.remove(ctx.payload.id);
						return withDisplay(
							{ ok: true },
							{ text: `Removed directive: ${ctx.payload.id}`, mimeType: "text/plain" },
						);
					},
				),
			}
		: {};

	return defineOrgan(
		"alef",
		{
			...promptTools,
			"motor/alef.sessions.list": typedAction(
				{
					name: "alef.sessions.list",
					description: "List all Alef sessions across all working directories, newest first.",
					inputSchema: z.object({}),
				},
				async () => {
					const sessions = await listAllSessions();
					return withDisplay({ sessions }, { text: `${sessions.length} session(s)`, mimeType: "text/plain" });
				},
				{ shouldCache: () => false },
			),
			"motor/alef.sessions.search": typedAction(
				{
					name: "alef.sessions.search",
					description: "Search sessions by keyword across name, first message, and conversation content.",
					inputSchema: z.object({ query: z.string().min(1).describe("Keyword or phrase to search for") }),
				},
				async (ctx) => {
					const results = await searchSessions(ctx.payload.query);
					return withDisplay(
						{ results },
						{ text: `${results.length} session(s) matching "${ctx.payload.query}"`, mimeType: "text/plain" },
					);
				},
			),
			"motor/alef.sessions.rename": typedAction(
				{
					name: "alef.sessions.rename",
					description: "Give a session a human-readable name so it can be found later.",
					inputSchema: z.object({
						id: z.string().min(1).describe("8-char session ID"),
						name: z.string().min(1).describe("Concise descriptive name, e.g. 'ToolShell eval and amnesia fix'"),
					}),
				},
				async (ctx) => {
					const result = await renameSession(ctx.payload.id, ctx.payload.name);
					return withDisplay(result, {
						text: result.ok
							? `Renamed session ${ctx.payload.id} to "${ctx.payload.name}"`
							: `Rename failed: ${result.error}`,
						mimeType: "text/plain",
					});
				},
			),
			"motor/alef.sessions.read": typedAction(
				{
					name: "alef.sessions.read",
					description: "Read the first N turns of a session by ID.",
					inputSchema: z.object({
						id: z.string().min(1).describe("8-char session ID"),
						maxTurns: z.number().optional().default(10).describe("Max turns to return (default 10)"),
					}),
				},
				async (ctx) => {
					const turns = await readSessionTurns(ctx.payload.id, ctx.payload.maxTurns);
					return withDisplay(
						{ turns },
						{ text: `${turns.length} turn(s) from session ${ctx.payload.id}`, mimeType: "text/plain" },
					);
				},
			),
			"motor/alef.config.get": typedAction(
				{
					name: "alef.config.get",
					description: "Get the current Alef config from ~/.config/alef/config.yaml.",
					inputSchema: z.object({}),
				},
				async () => {
					const config = await getConfig();
					return withDisplay({ config }, { text: "Alef config loaded", mimeType: "text/plain" });
				},
				{ shouldCache: () => true },
			),
			"motor/alef.organs.list": typedAction(
				{
					name: "alef.organs.list",
					description: "List user-installed organs from ~/.config/alef/organs.yaml.",
					inputSchema: z.object({}),
				},
				async () => {
					const organs = await listOrgans();
					return withDisplay({ organs }, { text: "organs.yaml loaded", mimeType: "text/plain" });
				},
				{ shouldCache: () => true },
			),
			"motor/alef.pm.history": typedAction(
				{
					name: "alef.pm.history",
					description: "List organ package manager generation history.",
					inputSchema: z.object({}),
				},
				async () => {
					const history = await pmHistory();
					return withDisplay(
						{ history },
						{ text: `${history.length} generation(s) in PM history`, mimeType: "text/plain" },
					);
				},
				{ shouldCache: () => true },
			),
			"motor/alef.rebuild": typedAction(
				{
					name: "alef.rebuild",
					description:
						"Trigger a blue-green rebuild: runs npm run check, spawns a new green with the same session, " +
						"and promotes it if healthy. Only available when running under the supervisor (alef-dev.sh). " +
						"Use after editing source files to apply the fix without losing session context.",
					inputSchema: z.object({}),
				},
				async (ctx) => {
					const trigger = (globalThis as Record<string, unknown>).alefRequestRebuild;
					if (typeof trigger !== "function") {
						ctx.log.warn({}, "alef.rebuild called but supervisor is not running");
						return withDisplay(
							{ ok: false, reason: "supervisor not running — start with alef-dev.sh" },
							{ text: "rebuild: supervisor not running — start with alef-dev.sh", mimeType: "text/plain" },
						);
					}
					trigger();
					ctx.log.info({}, "alef.rebuild: rebuild requested");
					return withDisplay(
						{ ok: true, reason: "rebuild requested — new green will take over when healthy" },
						{
							text: "rebuild: triggered — new green spawning, session will continue on promotion",
							mimeType: "text/plain",
						},
					);
				},
			),
		},

		{
			description: "Query Alef sessions, config, organs, package manager history, and manage the system prompt.",
			directives: [
				"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic — it searches name, first message, and content. " +
					"Use alef.sessions.read to get the content of a specific session. " +
					"Use alef.sessions.rename to give a session a memorable name when asked. " +
					"Use alef.config.get, alef.organs.list, alef.pm.history for system information. " +
					"Use alef.directive.list to show the active prompt blocks. Use alef.directive.enable/disable/toggle to change which blocks are active. " +
					"Use alef.directive.replace to change block content. Use alef.directive.add to inject a new block. " +
					"Use alef.rebuild to apply source edits via a zero-downtime blue-green swap (requires alef-dev.sh). " +
					"Respond concisely with the most relevant data. Do not write files.",
			],
			labels: ["alef-api", "meta", "sessions", "scroll"],
		},
	);
}
