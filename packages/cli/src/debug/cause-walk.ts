/* eslint-disable @typescript-eslint/no-base-to-string -- libsql Value type requires explicit String() casts */
/**
 * Causal span walk helpers for `alef log cause`.
 */

import type { Client, InValue } from "@libsql/client";

/** Flags for `alef log cause`. */
export interface CauseFlags {
	spanId?: string;
	path?: string;
	type?: string;
}

/** Parse `alef log cause` positional span-id and --path / --type flags. */
export function parseCauseFlags(args: string[]): CauseFlags {
	const out: CauseFlags = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--path") {
			out.path = args[++i];
		} else if (arg === "--type") {
			out.type = args[++i];
		} else if (!arg.startsWith("-") && !out.spanId) {
			out.spanId = arg;
		}
	}
	return out;
}

/** Resolve a span id from an effect event matched by path and/or type. */
export async function resolveSpanIdFromEffect(db: Client, flags: CauseFlags): Promise<string | null> {
	const clauses: string[] = [];
	const sqlArgs: InValue[] = [];
	if (flags.type) {
		clauses.push("type = ?");
		sqlArgs.push(flags.type);
	}
	if (flags.path) {
		clauses.push("payload LIKE ?");
		sqlArgs.push(`%${flags.path}%`);
	}
	if (clauses.length === 0) return null;

	const eventRows = (
		await db.execute({
			sql: `SELECT type, correlation_id, payload FROM events WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC LIMIT 1`,
			args: sqlArgs,
		})
	).rows;
	if (eventRows.length === 0) return null;

	const event = eventRows[0]!;
	const correlationId = String(event.correlation_id);
	const eventType = String(event.type);
	let toolCallId: string | undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON payload from events table
		const payload = JSON.parse(String(event.payload)) as Record<string, unknown>;
		if (typeof payload.toolCallId === "string") toolCallId = payload.toolCallId;
	} catch {
		// ignore
	}

	if (toolCallId) {
		const byCall = (
			await db.execute({
				sql: "SELECT span_id FROM spans WHERE attributes LIKE ? ORDER BY start_time DESC LIMIT 1",
				args: [`%${toolCallId}%`] as InValue[],
			})
		).rows;
		if (byCall.length > 0) return String(byCall[0]!.span_id);
	}

	const spanName = `alef.command/${eventType}`;
	const byCorr = (
		await db.execute({
			sql: "SELECT span_id FROM spans WHERE name = ? AND attributes LIKE ? ORDER BY start_time DESC LIMIT 1",
			args: [spanName, `%${correlationId}%`] as InValue[],
		})
	).rows;
	if (byCorr.length > 0) return String(byCorr[0]!.span_id);

	const byName = (
		await db.execute({
			sql: "SELECT span_id FROM spans WHERE name = ? ORDER BY start_time DESC LIMIT 1",
			args: [spanName] as InValue[],
		})
	).rows;
	return byName.length > 0 ? String(byName[0]!.span_id) : null;
}

/** One hop in a causal span chain. */
export interface CauseSpan {
	name: string;
	spanId: string;
	duration: number;
	attributes: string;
	parentSessionId?: string;
}

/** Walk parent_span_id chain; surface alef.parent.session_id when present. */
export async function walkCauseChain(db: Client, spanId: string): Promise<CauseSpan[]> {
	const chain: CauseSpan[] = [];
	const visited = new Set<string>();
	let nextId: string | null = spanId;

	while (nextId && !visited.has(nextId)) {
		visited.add(nextId);
		const rows: Array<Record<string, unknown>> = (
			await db.execute({
				sql: "SELECT span_id, parent_span_id, name, start_time, end_time, attributes FROM spans WHERE span_id LIKE ?",
				args: [`${nextId}%`] as InValue[],
			})
		).rows;

		if (rows.length === 0) break;

		const row = rows[0]!;
		const attributes = String(row.attributes ?? "{}");
		let parentSessionId: string | undefined;
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse from DB field
			const attrs = JSON.parse(attributes) as Record<string, unknown>;
			if (typeof attrs["alef.parent.session_id"] === "string") {
				parentSessionId = attrs["alef.parent.session_id"];
			}
		} catch {
			// skip
		}

		chain.push({
			name: String(row.name),
			spanId: String(row.span_id).slice(0, 16),
			duration: Number(row.end_time) - Number(row.start_time),
			attributes,
			parentSessionId,
		});

		nextId = row.parent_span_id ? String(row.parent_span_id) : null;
	}

	return chain;
}
