import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { alefConfigDir, alefDataDir } from "@dpopsuev/alef-kernel/xdg";
import { scanSessionFiles } from "@dpopsuev/alef-session/store";

const generationsDir = () => join(alefDataDir(), "generations");

/**
 *
 */
export interface SessionEntry {
	id: string;
	cwdHash: string;
	mtime: string;
	name: string | undefined;
	firstMessage: string;
	contentFingerprint: string;
	eventCount: number;
}

/**
 *
 */
async function parseSession(
	path: string,
	dialogEventType: string,
): Promise<{ name: string | undefined; firstMessage: string; contentFingerprint: string; eventCount: number }> {
	try {
		const raw = await readFile(path, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		let name: string | undefined;
		let firstMessage = "";
		const contentParts: string[] = [];
		for (const line of lines) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL schema enforced by session writer
				const r = JSON.parse(line) as { bus?: string; type?: string; payload?: { text?: string; name?: string } };
				if (r.bus === "internal" && r.type === "session.name" && typeof r.payload?.name === "string") {
					name = r.payload.name;
				}
				if (r.bus === "event" && r.type === dialogEventType) {
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

/**
 *
 */
export async function listAllSessions(dialogEventType: string): Promise<SessionEntry[]> {
	const results: SessionEntry[] = [];
	await scanSessionFiles(async (id, path, cwdHash) => {
		const s = await stat(path);
		const parsed = await parseSession(path, dialogEventType);
		results.push({ id, cwdHash, mtime: s.mtime.toISOString(), ...parsed });
	});
	return results.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 *
 */
export async function readSessionTurns(
	id: string,
	dialogEventType: string,
	maxTurns = 10,
): Promise<{ turn: string; type: string }[]> {
	let found: { turn: string; type: string }[] = [];
	await scanSessionFiles(async (sessionId, path) => {
		if (sessionId !== id || found.length > 0) return;
		const raw = await readFile(path, "utf-8");
		const turns: { turn: string; type: string }[] = [];
		for (const line of raw.split("\n").filter(Boolean)) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL schema enforced by session writer
				const r = JSON.parse(line) as { type?: string; payload?: { text?: string } };
				if (r.type === dialogEventType) {
					const text = r.payload?.text ?? "";
					if (text) turns.push({ turn: text.slice(0, 200), type: "message" });
					if (turns.length >= maxTurns) break;
				}
			} catch {
				break;
			}
		}
		found = turns;
	});
	return found;
}

/**
 *
 */
export async function renameSession(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
	let renamed = false;
	await scanSessionFiles(async (sessionId, path) => {
		if (sessionId !== id || renamed) return;
		const record = JSON.stringify({
			bus: "internal",
			type: "session.name",
			correlationId: "meta",
			payload: { name },
			timestamp: Date.now(),
		});
		const { appendFile } = await import("node:fs/promises");
		await appendFile(path, `${record}\n`, "utf-8");
		renamed = true;
	});
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated inside awaited callback
	return renamed ? { ok: true } : { ok: false, error: `Session '${id}' not found` };
}

/**
 *
 */
export async function searchSessions(
	query: string,
	dialogEventType: string,
): Promise<Array<{ id: string; mtime: string; name: string | undefined; snippet: string }>> {
	const all = await listAllSessions(dialogEventType);
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

/**
 *
 */
export async function getConfig(): Promise<Record<string, unknown>> {
	try {
		const path = join(alefConfigDir(), "config.yaml");
		const raw = await readFile(path, "utf-8");
		return { raw };
	} catch {
		return { raw: "(no config file)" };
	}
}

/**
 *
 */
export async function listAdapters(): Promise<string[]> {
	try {
		const path = join(alefConfigDir(), "adapters.yaml");
		const raw = await readFile(path, "utf-8");
		return [raw];
	} catch {
		return ["(adapters.yaml not found)"];
	}
}

/**
 *
 */
export async function pmHistory(): Promise<Array<{ id: number; ts: string; adapters: Record<string, string> }>> {
	try {
		const genDir = generationsDir();
		const files = await readdir(genDir);
		const entries = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => {
					const raw = await readFile(join(genDir, f), "utf-8");
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generation file schema is stable
					const gen = JSON.parse(raw) as { id: number; ts: string; lockfileContent: string };
					const adapters: Record<string, string> = {};
					try {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- lockfile JSON shape is well-known
						const lock = JSON.parse(gen.lockfileContent) as { packages?: Record<string, { version?: string }> };
						for (const [k, v] of Object.entries(lock.packages ?? {})) {
							if (k.startsWith("node_modules/")) adapters[k.slice("node_modules/".length)] = v.version ?? "?";
						}
					} catch {
						/* no lockfile */
					}
					return { id: gen.id, ts: gen.ts, adapters };
				}),
		);
		return entries.sort((a, b) => b.id - a.id);
	} catch {
		return [];
	}
}
