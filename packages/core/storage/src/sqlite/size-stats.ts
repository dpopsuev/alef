/* eslint-disable @typescript-eslint/no-base-to-string -- libsql Value type requires explicit String() casts */
/**
 * Session payload size forensics — SQL LENGTH only, no JSON.parse.
 */

import type { Client } from "@libsql/client";
import {
	MAX_PAYLOAD_BYTES,
	MAX_WARM_EVENTS,
	PREVIEW_EVENT_SQL_FILTER,
	WARM_EVENT_SQL_FILTER,
} from "./event-load.js";

/**
 *
 */
export interface TypePayloadStat {
	type: string;
	count: number;
	bytes: number;
	maxBytes: number;
}

/**
 *
 */
export interface WindowPayloadStat {
	count: number;
	bytes: number;
	maxBytes: number;
}

/**
 *
 */
export interface SessionPayloadStats {
	sessionId: string;
	total: WindowPayloadStat;
	byType: TypePayloadStat[];
	maxPayloadBytes: number;
	legacyWarm: WindowPayloadStat;
	boundedWarm: WindowPayloadStat;
	preview: WindowPayloadStat;
}

/** Run a COUNT/SUM/MAX LENGTH query shaped like WindowPayloadStat. */
async function windowStat(
	client: Client,
	sql: string,
	args: Array<string | number>,
): Promise<WindowPayloadStat> {
	const result = await client.execute({ sql, args });
	return {
		count: Number(result.rows[0]?.n ?? 0),
		bytes: Number(result.rows[0]?.bytes ?? 0),
		maxBytes: Number(result.rows[0]?.max_bytes ?? 0),
	};
}

/** Aggregate payload sizes for a session (LENGTH only). */
export async function getSessionPayloadStats(
	client: Client,
	sessionId: string,
	topN = 20,
): Promise<SessionPayloadStats> {
	const byTypeResult = await client.execute({
		sql: `SELECT type,
				COUNT(*) AS n,
				SUM(LENGTH(payload)) AS bytes,
				MAX(LENGTH(payload)) AS max_bytes
			FROM events
			WHERE session_id = ?
			GROUP BY type
			ORDER BY bytes DESC
			LIMIT ?`,
		args: [sessionId, topN],
	});

	const byType: TypePayloadStat[] = byTypeResult.rows.map((row) => ({
		type: String(row.type ?? ""),
		count: Number(row.n ?? 0),
		bytes: Number(row.bytes ?? 0),
		maxBytes: Number(row.max_bytes ?? 0),
	}));

	const total = await windowStat(
		client,
		`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
			COALESCE(MAX(LENGTH(payload)), 0) AS max_bytes
		FROM events WHERE session_id = ?`,
		[sessionId],
	);

	const legacyWarm = await windowStat(
		client,
		`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
			COALESCE(MAX(LENGTH(payload)), 0) AS max_bytes
		FROM (
			SELECT payload FROM events
			WHERE session_id = ?
			ORDER BY rowid DESC
			LIMIT ?
		)`,
		[sessionId, MAX_WARM_EVENTS],
	);

	const boundedWarm = await windowStat(
		client,
		`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
			COALESCE(MAX(LENGTH(payload)), 0) AS max_bytes
		FROM (
			SELECT payload FROM events
			WHERE session_id = ?
			AND (${WARM_EVENT_SQL_FILTER})
			ORDER BY rowid DESC
			LIMIT ?
		)`,
		[sessionId, MAX_WARM_EVENTS],
	);

	const preview = await windowStat(
		client,
		`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
			COALESCE(MAX(LENGTH(payload)), 0) AS max_bytes
		FROM (
			SELECT payload FROM events
			WHERE session_id = ?
			AND (${PREVIEW_EVENT_SQL_FILTER})
			ORDER BY rowid DESC
			LIMIT 500
		)`,
		[sessionId],
	);

	return {
		sessionId,
		total,
		byType,
		maxPayloadBytes: MAX_PAYLOAD_BYTES,
		legacyWarm,
		boundedWarm,
		preview,
	};
}
