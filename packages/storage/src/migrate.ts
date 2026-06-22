import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StorageRecord } from "@dpopsuev/alef-session";
import type Database from "better-sqlite3";

export interface MigrationResult {
	sessions: number;
	events: number;
	discourse: number;
	auth: number;
	skipped: number;
}

function deriveOrgan(type: string): string | null {
	const dot = type.indexOf(".");
	return dot > 0 ? type.slice(0, dot) : null;
}

export function needsMigration(db: Database.Database): boolean {
	const row = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
	if (row.cnt > 0) return false;

	const sessionRoot = join(homedir(), ".alef", "sessions");
	return existsSync(sessionRoot);
}

export function migrateJsonlToSqlite(db: Database.Database): MigrationResult {
	const sessionRoot = join(homedir(), ".alef", "sessions");
	const result: MigrationResult = { sessions: 0, events: 0, discourse: 0, auth: 0, skipped: 0 };

	if (!existsSync(sessionRoot)) return result;

	const insertSession = db.prepare(
		"INSERT OR IGNORE INTO sessions (id, cwd_hash, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)",
	);
	const insertEvent = db.prepare(
		`INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, elapsed, hash,
		   actor_address, actor_type, organ, turn_number, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const cwdHashes = readdirSync(sessionRoot).filter((e) => {
		try {
			return statSync(join(sessionRoot, e)).isDirectory();
		} catch {
			return false;
		}
	});

	for (const hash of cwdHashes) {
		const dir = join(sessionRoot, hash);
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const sessionId = file.replace(".jsonl", "");
			const filePath = join(dir, file);

			let raw: string;
			try {
				raw = readFileSync(filePath, "utf-8");
			} catch {
				result.skipped++;
				continue;
			}

			const lines = raw.split("\n").filter(Boolean);
			if (lines.length === 0) {
				result.skipped++;
				continue;
			}

			const records: StorageRecord[] = [];
			for (const line of lines) {
				try {
					records.push(JSON.parse(line) as StorageRecord);
				} catch {
					result.skipped++;
				}
			}

			if (records.length === 0) continue;

			const firstTs = records[0].timestamp ?? Date.now();
			const lastTs = records[records.length - 1].timestamp ?? Date.now();

			const migrate = db.transaction(() => {
				insertSession.run(sessionId, hash, firstTs, lastTs, "migrated");

				let turnIndex = 0;
				const turnMap = new Map<string, number>();

				for (const r of records) {
					if ((r.bus === "motor" || r.bus === "sense") && !turnMap.has(r.correlationId)) {
						turnMap.set(r.correlationId, turnIndex++);
					}

					insertEvent.run(
						sessionId,
						r.bus,
						r.type,
						r.correlationId,
						JSON.stringify(r.payload),
						r.timestamp,
						r.elapsed ?? null,
						r.hash ?? null,
						r.actor?.address ?? null,
						r.actor?.type ?? null,
						deriveOrgan(r.type),
						turnMap.get(r.correlationId) ?? null,
						"migrated",
					);
					result.events++;
				}

				result.sessions++;
			});

			try {
				migrate();
			} catch {
				result.skipped++;
			}

			const summaryPath = filePath.replace(".jsonl", ".summary.json");
			if (existsSync(summaryPath)) {
				try {
					const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
					db.prepare(
						`INSERT OR IGNORE INTO session_summaries (session_id, model, started_at, duration_ms, turns,
						   input_tokens, output_tokens, tools, errors)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						sessionId,
						summary.model ?? "unknown",
						summary.started_at ?? "",
						summary.duration_ms ?? 0,
						summary.turns ?? 0,
						(summary.tokens as { input?: number })?.input ?? 0,
						(summary.tokens as { output?: number })?.output ?? 0,
						JSON.stringify(summary.tools ?? []),
						summary.errors ?? 0,
					);
				} catch {}
			}
		}

		const discourseDir = join(dir, "discourse");
		if (existsSync(discourseDir)) {
			result.discourse += migrateDiscourse(db, discourseDir, hash);
		}
	}

	result.auth = migrateAuth(db);

	return result;
}

function migrateDiscourse(db: Database.Database, discourseRoot: string, sessionContextHash: string): number {
	let count = 0;
	const insert = db.prepare(
		"INSERT INTO discourse_posts (session_id, topic, thread, author, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
	);

	const topics = readdirSync(discourseRoot).filter((e) => {
		try {
			return statSync(join(discourseRoot, e)).isDirectory();
		} catch {
			return false;
		}
	});

	for (const topic of topics) {
		const topicDir = join(discourseRoot, topic);
		const threads = readdirSync(topicDir).filter((f) => f.endsWith(".jsonl"));

		for (const threadFile of threads) {
			const thread = threadFile.replace(".jsonl", "");
			try {
				const raw = readFileSync(join(topicDir, threadFile), "utf-8");
				for (const line of raw.split("\n").filter(Boolean)) {
					try {
						const post = JSON.parse(line) as { author: string; content: unknown; timestamp: number };
						insert.run(
							sessionContextHash,
							topic,
							thread,
							post.author,
							JSON.stringify(post.content),
							post.timestamp,
						);
						count++;
					} catch {}
				}
			} catch {}
		}
	}

	return count;
}

function migrateAuth(db: Database.Database): number {
	const authPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alef", "auth.json");
	if (!existsSync(authPath)) return 0;

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { type: string; key: string }>;
		const insert = db.prepare("INSERT OR IGNORE INTO auth (provider, type, key) VALUES (?, ?, ?)");
		let count = 0;
		for (const [provider, cred] of Object.entries(data)) {
			if (cred.key) {
				insert.run(provider, cred.type ?? "api_key", cred.key);
				count++;
			}
		}
		return count;
	} catch {
		return 0;
	}
}
