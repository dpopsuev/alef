/* eslint-disable @typescript-eslint/no-base-to-string -- libsql Value type requires explicit String() casts */
/**
 * alef debug session — inspect session events for tool-call pairing issues.
 *
 * Usage:
 *   alef debug session              — inspect most recent session for current cwd
 *   alef debug session <id>         — inspect session by ID prefix
 *   alef debug session --list       — list sessions for current cwd
 *
 * Uses SQL with truncated payloads — never resumes/warms the full session
 * (fat context.assemble rows must not JSON.parse into OOM).
 */

import type { SessionStoreFactory } from "@dpopsuev/alef-storage";
import { getDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { WARM_EVENT_SQL_FILTER } from "@dpopsuev/alef-storage/sqlite/event-load";
import type { Client } from "@libsql/client";

/** Inspect a session for orphaned tool-call commands or list available sessions. */
export async function runDebugSession(args: string[], cwd: string, sessions: SessionStoreFactory): Promise<void> {
	if (args.includes("--list") || args.includes("-l")) {
		await listSessions(cwd, sessions);
		return;
	}

	const idPrefix = args[0];
	await inspectSession(cwd, sessions, idPrefix);
}

/** Print all session IDs and modification times for the given working directory. */
async function listSessions(cwd: string, sessions: SessionStoreFactory): Promise<void> {
	const list = await sessions.list(cwd);
	if (list.length === 0) {
		console.log("No sessions for", cwd);
		return;
	}
	for (const s of list) {
		console.log(`${s.id}  ${s.mtime.toISOString().replace("T", " ").slice(0, 16)}`);
	}
}

/** Load pairing rows via SQL (substr payloads) and report command/event issues. */
async function inspectSession(cwd: string, sessions: SessionStoreFactory, idPrefix?: string): Promise<void> {
	const list = await sessions.list(cwd);
	if (list.length === 0) {
		console.error("No sessions for", cwd);
		process.exit(1);
	}

	let target = list[0];
	if (idPrefix) {
		const found = list.find((s) => s.id.startsWith(idPrefix));
		if (!found) {
			console.error(`No session matching '${idPrefix}'. Run 'alef debug session --list'.`);
			process.exit(1);
		}
		target = found;
	}

	const sessionId = target!.id;
	const db = await getDatabase();
	await inspectPairing(db, sessionId);
}

/**
 *
 */
interface PairRow {
	bus: string;
	type: string;
	correlationId: string;
	timestamp: number;
	isError: boolean;
}

/** Query bounded warm-filter events with truncated payloads for pairing analysis. */
async function loadPairRows(db: Client, sessionId: string): Promise<PairRow[]> {
	const result = await db.execute({
		sql: `SELECT bus, type, correlation_id,
				timestamp,
				CASE
					WHEN substr(payload, 1, 500) LIKE '%"isError":true%'
						OR substr(payload, 1, 500) LIKE '%"isError": true%'
					THEN 1 ELSE 0
				END AS is_error
			FROM events
			WHERE session_id = ?
			AND (${WARM_EVENT_SQL_FILTER})
			ORDER BY rowid ASC`,
		args: [sessionId],
	});

	return result.rows.map((row) => ({
		bus: String(row.bus ?? ""),
		type: String(row.type ?? ""),
		correlationId: String(row.correlation_id ?? ""),
		timestamp: Number(row.timestamp ?? 0),
		isError: Number(row.is_error ?? 0) === 1,
	}));
}

/** Report command/event pairing for a session without materializing fat payloads. */
async function inspectPairing(db: Client, sessionId: string): Promise<void> {
	const records = await loadPairRows(db, sessionId);

	const motorByCorr = new Map<string, PairRow[]>();
	const senseByCorr = new Map<string, PairRow[]>();
	let turns = 0;
	let errors = 0;

	for (const r of records) {
		const key = r.correlationId;
		if (r.bus === "command") {
			if (r.type === "llm.response") {
				turns++;
				continue;
			}
			if (!motorByCorr.has(key)) motorByCorr.set(key, []);
			motorByCorr.get(key)!.push(r);
		} else if (r.bus === "event") {
			if (r.isError) errors++;
			if (r.type === "llm.input") continue;
			if (!senseByCorr.has(key)) senseByCorr.set(key, []);
			senseByCorr.get(key)!.push(r);
		}
	}

	console.log(`Session: ${sessionId}`);
	console.log(`Events:  ${records.length} (warm filter)  Turns: ${turns}  Errors: ${errors}`);
	console.log();

	const issues: string[] = [];
	let paired = 0;
	let orphaned = 0;

	for (const [corrId, motorEvents] of motorByCorr) {
		const senseEvents = senseByCorr.get(corrId) ?? [];
		const short = corrId.slice(0, 8);

		for (const m of motorEvents) {
			const matched = senseEvents.find((s) => s.type === m.type);
			if (matched) {
				paired++;
				const elapsedMs = matched.timestamp - m.timestamp;
				console.log(`  ok ${short}  ${m.type}  ${elapsedMs}ms`);
			} else {
				orphaned++;
				issues.push(`orphaned command/${m.type} (corr=${short}) — no sense response`);
				console.log(`  -- ${short}  ${m.type}  NO SENSE RESPONSE`);
			}
		}
	}

	console.log();
	console.log(`Paired: ${paired}  Orphaned: ${orphaned}`);

	if (issues.length > 0) {
		console.log();
		console.log("Issues:");
		for (const issue of issues) console.log(`  • ${issue}`);
		process.exit(1);
	} else {
		console.log("Session is clean.");
	}
}
