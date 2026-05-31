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
import { defineOrgan, typedAction } from "@dpopsuev/alef-spine";
import { z } from "zod";

const SESSION_ROOT = join(homedir(), ".alef", "sessions");
const CONFIG_ROOT = join(homedir(), ".config", "alef");

async function listAllSessions(): Promise<
	Array<{ id: string; cwdHash: string; mtime: string; firstMessage: string; eventCount: number }>
> {
	const results = [];
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
						const raw = await readFile(path, "utf-8");
						const lines = raw.split("\n").filter(Boolean);
						let firstMessage = "";
						for (const line of lines) {
							try {
								const r = JSON.parse(line) as { bus?: string; type?: string; payload?: { text?: string } };
								if (r.bus === "sense" && r.type === "dialog.message") {
									firstMessage = (r.payload?.text ?? "").slice(0, 80).replace(/\n/g, " ");
									break;
								}
							} catch {
								break;
							}
						}
						results.push({ id, cwdHash, mtime: s.mtime.toISOString(), firstMessage, eventCount: lines.length });
					} catch {
						/* skip unreadable */
					}
				}
			} catch {
				/* skip inaccessible cwd dir */
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
						const r = JSON.parse(line) as {
							type?: string;
							payload?: { text?: string; conversationHistory?: unknown[] };
						};
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

async function searchSessions(query: string): Promise<Array<{ id: string; mtime: string; snippet: string }>> {
	const all = await listAllSessions();
	const lower = query.toLowerCase();
	return all
		.filter((s) => s.firstMessage.toLowerCase().includes(lower))
		.map((s) => ({
			id: s.id,
			mtime: s.mtime,
			snippet: s.firstMessage,
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

export function createAlefApiOrgan() {
	return defineOrgan(
		"alef",
		{
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
					description: "Search sessions by keyword in their first user message.",
					inputSchema: z.object({ query: z.string().describe("Keyword or phrase to search for") }),
				},
				async (ctx) => ({ results: await searchSessions(ctx.payload.query) }),
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
			description: "Query Alef sessions, config, organs, and package manager history.",
			directives: [
				"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions matching a topic. " +
					"Use alef.sessions.read to get the content of a specific session. " +
					"Use alef.config.get, alef.organs.list, alef.pm.history for system information. " +
					"Respond concisely with the most relevant data. Do not write files.",
			],
			labels: ["alef-api", "meta", "sessions"],
		},
	);
}
