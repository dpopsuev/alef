import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StorageRecord } from "@dpopsuev/alef-session";
import type { Client, InStatement } from "@libsql/client";

export interface MigrationResult {
	sessions: number;
	events: number;
	discourse: number;
	auth: number;
	skipped: number;
}

function deriveAdapter(type: string): string | null {
	const dot = type.indexOf(".");
	return dot > 0 ? type.slice(0, dot) : null;
}

export async function needsMigration(client: Client): Promise<boolean> {
	const result = await client.execute({
		sql: "SELECT COUNT(*) as cnt FROM sessions",
		args: [],
	});
	const row = result.rows[0];
	if (Number(row.cnt) > 0) return false;

	const sessionRoot = join(homedir(), ".alef", "sessions");
	return existsSync(sessionRoot);
}

export async function migrateJsonlToSqlite(client: Client): Promise<MigrationResult> {
	const sessionRoot = join(homedir(), ".alef", "sessions");
	const result: MigrationResult = { sessions: 0, events: 0, discourse: 0, auth: 0, skipped: 0 };

	if (!existsSync(sessionRoot)) return result;

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

			try {
				let turnIndex = 0;
				const turnMap = new Map<string, number>();

				const stmts: InStatement[] = [
					{
						sql: "INSERT OR IGNORE INTO sessions (id, cwd_hash, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)",
						args: [sessionId, hash, firstTs, lastTs, "migrated"],
					},
				];

				for (const r of records) {
					if ((r.bus === "command" || r.bus === "event") && !turnMap.has(r.correlationId)) {
						turnMap.set(r.correlationId, turnIndex++);
					}

					stmts.push({
						sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, elapsed, hash,
						   actor_address, actor_type, adapter, turn_number, version)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
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
							deriveAdapter(r.type),
							turnMap.get(r.correlationId) ?? null,
							"migrated",
						],
					});
					result.events++;
				}

				await client.batch(stmts, "write");
				result.sessions++;
			} catch {
				result.skipped++;
			}

			const summaryPath = filePath.replace(".jsonl", ".summary.json");
			if (existsSync(summaryPath)) {
				try {
					const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
					await client.execute({
						sql: `INSERT OR IGNORE INTO session_summaries (session_id, model, started_at, duration_ms, turns,
						   input_tokens, output_tokens, tools, errors)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
							sessionId,
							String(summary.model ?? "unknown"),
							String(summary.started_at ?? ""),
							Number(summary.duration_ms ?? 0),
							Number(summary.turns ?? 0),
							Number((summary.tokens as { input?: number })?.input ?? 0),
							Number((summary.tokens as { output?: number })?.output ?? 0),
							JSON.stringify(summary.tools ?? []),
							Number(summary.errors ?? 0),
						],
					});
				} catch {}
			}
		}

		const discourseDir = join(dir, "discourse");
		if (existsSync(discourseDir)) {
			result.discourse += await migrateDiscourse(client, discourseDir, hash);
		}
	}

	result.auth = await migrateAuth(client);

	return result;
}

async function migrateDiscourse(client: Client, discourseRoot: string, sessionContextHash: string): Promise<number> {
	let count = 0;

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
				const stmts: InStatement[] = [];
				for (const line of raw.split("\n").filter(Boolean)) {
					try {
						const post = JSON.parse(line) as { author: string; content: unknown; timestamp: number };
						stmts.push({
							sql: "INSERT INTO discourse_posts (session_id, topic, thread, author, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
							args: [
								sessionContextHash,
								topic,
								thread,
								post.author,
								JSON.stringify(post.content),
								post.timestamp,
							],
						});
						count++;
					} catch {}
				}
				if (stmts.length > 0) {
					await client.batch(stmts, "write");
				}
			} catch {}
		}
	}

	return count;
}

async function migrateAuth(client: Client): Promise<number> {
	const authPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alef", "auth.json");
	if (!existsSync(authPath)) return 0;

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { type: string; key: string }>;
		const stmts: InStatement[] = [];
		let count = 0;
		for (const [provider, cred] of Object.entries(data)) {
			if (cred.key) {
				stmts.push({
					sql: "INSERT OR IGNORE INTO auth (provider, type, key) VALUES (?, ?, ?)",
					args: [provider, cred.type ?? "api_key", cred.key],
				});
				count++;
			}
		}
		if (stmts.length > 0) {
			await client.batch(stmts, "write");
		}
		return count;
	} catch {
		return 0;
	}
}
