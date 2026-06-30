/* eslint-disable @typescript-eslint/no-base-to-string -- libsql Value type requires explicit String() casts */
/**
 * alef log — CLI tool for querying the session store.
 *
 * Subcommands:
 *   sessions [--search <q>]                        List sessions
 *   events <id> [filters...]                       Query events
 *   trace <id> <correlationId>                     Show one turn
 *   summary [<id>]                                 Token/tool/error summary
 *   tail [filters...]                              Latest session events
 *
 * Filters (composable, any combination):
 *   --bus <name>          command | event | notification | internal
 *   --type <pattern>      glob pattern, e.g. llm.* or tool:*
 *   --adapter <name>      filter by adapter prefix, e.g. fs, shell
 *   --after <time>        events after HH:MM:SS or ISO timestamp
 *   --before <time>       events before HH:MM:SS or ISO timestamp
 *   --corr <prefix>       correlationId prefix
 *   --errors              only error events
 *   --payload <substring> payload contains substring
 *   --limit <n>           max results (default 100)
 *   --json                JSON output
 */

import type { Client, InValue } from "@libsql/client";

/** Dispatch a log-query subcommand (sessions, events, trace, summary, tail, cause, spans). */
export async function runLogCommand(subcmd: string, args: string[]): Promise<void> {
	const { getDatabase } = await import("@dpopsuev/alef-storage/sqlite/database");
	const db = await getDatabase();

	switch (subcmd) {
		case "sessions":
			await listSessions(db, args);
			break;
		case "events":
			await queryEvents(db, args);
			break;
		case "trace":
			await traceCorrelation(db, args);
			break;
		case "summary":
			await showSummary(db, args);
			break;
		case "tail":
			await tailLatest(db, args);
			break;
		case "cause":
			await walkCause(db, args);
			break;
		case "spans":
			await listSpans(db, args);
			break;
		default:
			console.error(`Unknown store subcommand: ${subcmd}`);
			console.error("Available: sessions, events, trace, summary, tail, cause, spans");
			process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Filter parser — composable key=value filters
// ---------------------------------------------------------------------------

interface EventFilters {
	bus?: string;
	typePattern?: string;
	adapter?: string;
	after?: number;
	before?: number;
	correlationId?: string;
	errorsOnly: boolean;
	payloadSubstring?: string;
	limit: number;
	json: boolean;
}

function parseFilters(args: string[]): EventFilters {
	const filters: EventFilters = { errorsOnly: false, limit: 100, json: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => args[++i] ?? "";

		switch (arg) {
			case "--bus":
				filters.bus = next();
				break;
			case "--type":
				filters.typePattern = next();
				break;
			case "--adapter":
				filters.adapter = next();
				break;
			case "--after":
				filters.after = parseTime(next());
				break;
			case "--before":
				filters.before = parseTime(next());
				break;
			case "--corr":
				filters.correlationId = next();
				break;
			case "--errors":
				filters.errorsOnly = true;
				break;
			case "--payload":
				filters.payloadSubstring = next();
				break;
			case "--limit":
				filters.limit = Number.parseInt(next(), 10) || 100;
				break;
			case "--json":
				filters.json = true;
				break;
		}
	}
	return filters;
}

function parseTime(s: string): number {
	if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
		const today = new Date();
		const parts = s.split(":").map(Number);
		today.setHours(parts[0], parts[1], parts[2] ?? 0, 0);
		return today.getTime();
	}
	const ts = Date.parse(s);
	return Number.isNaN(ts) ? 0 : ts;
}

function buildWhere(sessionId: string, filters: EventFilters): { where: string; args: InValue[] } {
	const conditions = ["session_id LIKE ?"];
	const sqlArgs: InValue[] = [`${sessionId}%`];

	if (filters.bus) {
		conditions.push("bus = ?");
		sqlArgs.push(filters.bus);
	}
	if (filters.typePattern) {
		conditions.push("type LIKE ?");
		sqlArgs.push(filters.typePattern.replace(/\*/g, "%"));
	}
	if (filters.adapter) {
		conditions.push("type LIKE ?");
		sqlArgs.push(`${filters.adapter}.%`);
	}
	if (filters.after) {
		conditions.push("timestamp >= ?");
		sqlArgs.push(filters.after);
	}
	if (filters.before) {
		conditions.push("timestamp <= ?");
		sqlArgs.push(filters.before);
	}
	if (filters.correlationId) {
		conditions.push("correlation_id LIKE ?");
		sqlArgs.push(`${filters.correlationId}%`);
	}
	if (filters.errorsOnly) {
		conditions.push("(type LIKE '%error%' OR type LIKE '%fail%' OR json_extract(payload, '$.isError') = true)");
	}
	if (filters.payloadSubstring) {
		conditions.push("payload LIKE ?");
		sqlArgs.push(`%${filters.payloadSubstring}%`);
	}

	return { where: conditions.join(" AND "), args: sqlArgs };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
	return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 3)}...`;
}

function pad(s: string, width: number): string {
	return s.padEnd(width);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function listSessions(db: Client, args: string[]): Promise<void> {
	const searchIdx = args.indexOf("--search");
	const search = searchIdx >= 0 ? args[searchIdx + 1] : undefined;

	let sql = `
		SELECT s.id, s.created_at, s.name,
			ss.model, ss.turns, ss.input_tokens, ss.output_tokens, ss.errors
		FROM sessions s
		LEFT JOIN session_summaries ss ON ss.session_id = s.id
		ORDER BY s.created_at DESC
		LIMIT 20
	`;
	let sqlArgs: InValue[] = [];

	if (search) {
		sql = `
			SELECT s.id, s.created_at, s.name,
				ss.model, ss.turns, ss.input_tokens, ss.output_tokens, ss.errors
			FROM sessions s
			LEFT JOIN session_summaries ss ON ss.session_id = s.id
			WHERE s.name LIKE ? OR s.id LIKE ?
			ORDER BY s.created_at DESC
			LIMIT 20
		`;
		sqlArgs = [`%${search}%`, `%${search}%`];
	}

	const result = await db.execute({ sql, args: sqlArgs });

	console.log(
		`${pad("ID", 10)} ${pad("Created", 21)} ${pad("Model", 22)} ${pad("Turns", 6)} ${pad("Tokens", 12)} Errors`,
	);
	console.log("-".repeat(85));

	for (const row of result.rows) {
		const id = String(row.id).slice(0, 8);
		const created = row.created_at ? fmtTime(Number(row.created_at)) : "unknown";
		const model = truncate(String(row.model ?? "?"), 20);
		const turns = String(row.turns ?? "?");
		const input = Number(row.input_tokens ?? 0);
		const output = Number(row.output_tokens ?? 0);
		const tokens = `${input}/${output}`;
		const errors = String(row.errors ?? 0);
		const name = row.name ? ` (${truncate(String(row.name), 30)})` : "";
		console.log(
			`${pad(id, 10)} ${pad(created, 21)} ${pad(model, 22)} ${pad(turns, 6)} ${pad(tokens, 12)} ${errors}${name}`,
		);
	}

	if (result.rows.length === 0) {
		console.log("No sessions found.");
	}
}

async function queryEvents(db: Client, args: string[]): Promise<void> {
	const sessionId = args[0];
	if (!sessionId || sessionId.startsWith("--")) {
		console.error(
			"Usage: alef log events <session-id> [--bus X] [--type X] [--adapter X] [--after HH:MM] [--before HH:MM] [--corr X] [--errors] [--payload X] [--limit N] [--json]",
		);
		process.exit(1);
	}

	const filters = parseFilters(args.slice(1));
	const { where, args: sqlArgs } = buildWhere(sessionId, filters);

	const sql = `
		SELECT bus, type, correlation_id, substr(payload, 1, 200) as payload_short, timestamp, elapsed
		FROM events
		WHERE ${where}
		ORDER BY timestamp
		LIMIT ?
	`;
	sqlArgs.push(filters.limit);

	const result = await db.execute({ sql, args: sqlArgs });

	if (filters.json) {
		for (const row of result.rows) {
			console.log(JSON.stringify(row));
		}
		return;
	}

	console.log(`${pad("Time", 13)} ${pad("Bus", 14)} ${pad("Type", 25)} ${pad("CorrID", 10)} Payload`);
	console.log("-".repeat(100));

	for (const row of result.rows) {
		const time = row.timestamp ? fmtTime(Number(row.timestamp)).slice(11) : "?";
		const b = pad(String(row.bus), 14);
		const type = pad(truncate(String(row.type), 23), 25);
		const corrId = pad(String(row.correlation_id ?? "").slice(0, 8), 10);
		const payload = truncate(String(row.payload_short ?? ""), 60);
		console.log(`${pad(time, 13)} ${b} ${type} ${corrId} ${payload}`);
	}

	console.log(`\n${result.rows.length} event(s)`);
}

async function traceCorrelation(db: Client, args: string[]): Promise<void> {
	const sessionId = args[0];
	const correlationId = args[1];
	if (!sessionId || !correlationId) {
		console.error("Usage: alef log trace <session-id> <correlationId>");
		process.exit(1);
	}

	const result = await db.execute({
		sql: `
			SELECT bus, type, payload, timestamp, elapsed
			FROM events
			WHERE session_id LIKE ? AND correlation_id LIKE ?
			ORDER BY timestamp
		`,
		args: [`${sessionId}%`, `${correlationId}%`],
	});

	if (result.rows.length === 0) {
		console.log(`No events for correlationId ${correlationId} in session ${sessionId}`);
		return;
	}

	const first = Number(result.rows[0].timestamp);
	const last = Number(result.rows[result.rows.length - 1]?.timestamp ?? first);
	console.log(`[Turn ${correlationId.slice(0, 8)} — ${((last - first) / 1000).toFixed(1)}s]`);

	for (const row of result.rows) {
		const bus = String(row.bus);
		const type = String(row.type);
		const arrow = bus === "event" ? "→" : "←";
		const busLabel = pad(bus.slice(0, 8), 9);

		let preview = "";
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse from DB field
			const p = JSON.parse(String(row.payload)) as Record<string, unknown>;
			if (typeof p.text === "string") preview = `"${truncate(p.text, 50)}"`;
			else if (typeof p.name === "string") preview = p.name;
			else if (p.usage) preview = `tokens: ${JSON.stringify(p.usage)}`;
		} catch {
			// skip
		}

		const elapsed = row.elapsed ? ` ${Number(row.elapsed)}ms` : "";
		console.log(`  ${arrow} ${busLabel} ${pad(type, 22)} ${preview}${elapsed}`);
	}
}

async function showSummary(db: Client, args: string[]): Promise<void> {
	const sessionId = args[0] ?? "latest";

	let resolvedId = sessionId;
	if (sessionId === "latest") {
		const r = await db.execute({ sql: "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1", args: [] });
		resolvedId = String(r.rows[0]?.id ?? "");
		if (!resolvedId) {
			console.log("No sessions found.");
			return;
		}
	}

	const summary = await db.execute({
		sql: "SELECT * FROM session_summaries WHERE session_id LIKE ?",
		args: [`${resolvedId}%`],
	});

	if (summary.rows.length === 0) {
		console.log(`No summary for session ${resolvedId}. (Session may not have completed.)`);
		return;
	}

	const s = summary.rows[0];
	console.log(`Session:  ${String(s.session_id)}`);
	console.log(`Model:    ${String(s.model)}`);
	console.log(`Started:  ${String(s.started_at)}`);
	console.log(`Duration: ${Number(s.duration_ms ?? 0) / 1000}s`);
	console.log(`Turns:    ${String(s.turns)}`);
	console.log(`Tokens:   ${String(s.input_tokens)} in / ${String(s.output_tokens)} out`);
	console.log(`Errors:   ${String(s.errors)}`);
	if (s.tools) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse from DB field
			const tools = JSON.parse(String(s.tools)) as Array<{ name: string; calls: number }>;
			if (tools.length > 0) {
				console.log("Tools:");
				for (const t of tools) console.log(`  ${t.name}: ${t.calls} calls`);
			}
		} catch {
			// skip
		}
	}
}

async function tailLatest(db: Client, args: string[]): Promise<void> {
	const session = await db.execute({
		sql: "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1",
		args: [],
	});

	if (session.rows.length === 0) {
		console.log("No sessions found.");
		return;
	}

	const sessionId = String(session.rows[0]?.id ?? "");
	console.log(`Session: ${sessionId}\n`);

	await queryEvents(db, [sessionId, ...args]);
}

async function listSpans(db: Client, args: string[]): Promise<void> {
	const sessionId = args[0];
	const limit = 50;

	let sql: string;
	let sqlArgs: InValue[];

	if (sessionId) {
		sql = `SELECT span_id, trace_id, parent_span_id, name, start_time, end_time, status
			FROM spans WHERE session_id LIKE ? ORDER BY start_time LIMIT ?`;
		sqlArgs = [`${sessionId}%`, limit];
	} else {
		sql = `SELECT span_id, trace_id, parent_span_id, name, start_time, end_time, status
			FROM spans ORDER BY start_time DESC LIMIT ?`;
		sqlArgs = [limit];
	}

	const result = await db.execute({ sql, args: sqlArgs });

	console.log(`${pad("SpanID", 18)} ${pad("Parent", 18)} ${pad("Name", 30)} ${pad("Duration", 10)} Status`);
	console.log("-".repeat(90));

	for (const row of result.rows) {
		const spanId = String(row.span_id).slice(0, 16);
		const parent = row.parent_span_id ? String(row.parent_span_id).slice(0, 16) : "(root)";
		const name = truncate(String(row.name), 28);
		const duration = `${Number(row.end_time) - Number(row.start_time)}ms`;
		const status = Number(row.status) === 0 ? "OK" : Number(row.status) === 2 ? "ERR" : "?";
		console.log(`${pad(spanId, 18)} ${pad(parent, 18)} ${pad(name, 30)} ${pad(duration, 10)} ${status}`);
	}

	console.log(`\n${result.rows.length} span(s)`);
}

async function walkCause(db: Client, args: string[]): Promise<void> {
	const spanId = args[0];
	if (!spanId) {
		console.error("Usage: alef log cause <span-id>");
		console.error("  Find span IDs with: alef log spans <session-id>");
		process.exit(1);
	}

	const chain: Array<{ name: string; spanId: string; duration: number; attributes: string }> = [];
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

		chain.push({
			name: String(rows[0].name),
			spanId: String(rows[0].span_id).slice(0, 16),
			duration: Number(rows[0].end_time) - Number(rows[0].start_time),
			attributes: String(rows[0].attributes ?? "{}"),
		});

		nextId = rows[0].parent_span_id ? String(rows[0].parent_span_id) : null;
	}

	if (chain.length === 0) {
		console.log(`No span found matching ${spanId}`);
		return;
	}

	console.log(`[Causal chain — ${chain.length} span(s)]`);
	for (let i = 0; i < chain.length; i++) {
		const s = chain[i];
		const indent = "  ".repeat(i);
		const arrow = i === 0 ? "→" : "←";

		let detail = "";
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse from DB field
			const attrs = JSON.parse(s.attributes) as Record<string, unknown>;
			if (typeof attrs["alef.correlation.id"] === "string")
				detail += ` corr:${String(attrs["alef.correlation.id"]).slice(0, 8)}`;
			if (typeof attrs["gen_ai.request.model"] === "string")
				detail += ` model:${String(attrs["gen_ai.request.model"])}`;
			if (typeof attrs["alef.tool.call.id"] === "string")
				detail += ` call:${String(attrs["alef.tool.call.id"]).slice(0, 12)}`;
		} catch {
			// skip
		}

		const label = i === chain.length - 1 ? " = ROOT" : "";
		console.log(`${indent}${arrow} ${s.name} (${s.spanId}, ${s.duration}ms)${detail}${label}`);
	}
}
