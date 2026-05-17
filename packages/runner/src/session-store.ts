/**
 * SessionStore — append-only JSONL session persistence.
 *
 * Storage layout:
 *   ~/.alef/sessions/<cwd-hash>/<session-id>.jsonl
 *   ~/.alef/sessions/<cwd-hash>/latest            — contains the last session ID
 *
 * Each line is a JSON-serialised ConversationMessage:
 *   {"role":"user","content":"fix the bug","timestamp":1234567890000}
 *   {"role":"assistant","content":"I'll fix it by...","timestamp":1234567890123}
 *
 * Session IDs are 8-char hex prefixes of a UUID — short enough to type,
 * unique enough for a single user's history.
 *
 * Usage:
 *   const store = await SessionStore.create(cwd);          // new session
 *   const store = await SessionStore.resume(cwd, id);      // resume by ID
 *   const store = await SessionStore.resumeLatest(cwd);    // resume last session
 *   await store.append(message);
 *   const history = await store.messages();
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PersistedMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

function cwdHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function sessionDir(cwd: string): string {
	return join(homedir(), ".alef", "sessions", cwdHash(cwd));
}

function sessionPath(cwd: string, id: string): string {
	return join(sessionDir(cwd), `${id}.jsonl`);
}

function latestPath(cwd: string): string {
	return join(sessionDir(cwd), "latest");
}

async function ensureDir(cwd: string): Promise<void> {
	await mkdir(sessionDir(cwd), { recursive: true });
}

export class SessionStore {
	readonly id: string;
	private readonly path: string;

	private constructor(cwd: string, id: string) {
		this.id = id;
		this.path = sessionPath(cwd, id);
	}

	/** Create a new session. */
	static async create(cwd: string): Promise<SessionStore> {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		await ensureDir(cwd);
		// Touch the file to create it.
		await appendFile(sessionPath(cwd, id), "");
		await writeFile(latestPath(cwd), id, "utf-8");
		return new SessionStore(cwd, id);
	}

	/** Resume a session by ID. Throws if the session file does not exist. */
	static async resume(cwd: string, id: string): Promise<SessionStore> {
		const path = sessionPath(cwd, id);
		try {
			await stat(path);
		} catch {
			throw new Error(`Session '${id}' not found in ${sessionDir(cwd)}`);
		}
		// Update latest pointer on resume.
		await writeFile(latestPath(cwd), id, "utf-8");
		return new SessionStore(cwd, id);
	}

	/** Resume the most recent session for this cwd. Returns null if none exists. */
	static async resumeLatest(cwd: string): Promise<SessionStore | null> {
		try {
			const id = (await readFile(latestPath(cwd), "utf-8")).trim();
			return id ? await SessionStore.resume(cwd, id) : null;
		} catch {
			return null;
		}
	}

	/** List all sessions for this cwd, newest first. */
	static async list(cwd: string): Promise<Array<{ id: string; path: string; mtime: Date }>> {
		try {
			const dir = sessionDir(cwd);
			const entries = await readdir(dir);
			const sessions = await Promise.all(
				entries
					.filter((e) => e.endsWith(".jsonl"))
					.map(async (e) => {
						const id = e.replace(".jsonl", "");
						const p = join(dir, e);
						const s = await stat(p);
						return { id, path: p, mtime: s.mtime };
					}),
			);
			return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
		} catch {
			return [];
		}
	}

	/** Append a message to the JSONL file. */
	async append(msg: PersistedMessage): Promise<void> {
		await appendFile(this.path, `${JSON.stringify(msg)}\n`, "utf-8");
	}

	/** Read all messages from the JSONL file. */
	async messages(): Promise<PersistedMessage[]> {
		try {
			const raw = await readFile(this.path, "utf-8");
			return raw
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as PersistedMessage);
		} catch {
			return [];
		}
	}
}
