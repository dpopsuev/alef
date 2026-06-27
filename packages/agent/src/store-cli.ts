/* eslint-disable @typescript-eslint/no-base-to-string -- libsql Value type requires explicit String() casts */
/**
 * alef store — CLI tool for querying the session store.
 *
 * Subcommands:
 *   sessions [--search <q>]              List sessions
 *   events <id> [--bus X] [--type X] [--errors] [--json]   Query events
 *   trace <id> <correlationId>           Show one turn's events
 *   summary <id>                         Token/tool/error summary
 *   tail [--json]                        Latest session events
 */

import type { Client } from "@libsql/client";

export async function runStoreCommand(subcmd: string, args: string[]): Promise<void> {
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
		default:
			console.error(`Unknown store subcommand: ${subcmd}`);
			console.error("Available: sessions, events, trace, summary, tail");
			process.exit(1);
	}
}

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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic SQL args
	let sqlArgs: any[] = [];

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
	if (!sessionId) {
		console.error("Usage: alef store events <session-id> [--bus X] [--type X] [--errors] [--json]");
		process.exit(1);
	}

	const busIdx = args.indexOf("--bus");
	const bus = busIdx >= 0 ? args[busIdx + 1] : undefined;
	const typeIdx = args.indexOf("--type");
	const typePattern = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
	const errorsOnly = args.includes("--errors");
	const jsonOutput = args.includes("--json");
	const limit = 100;

	const conditions = ["session_id LIKE ?"];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic SQL args
	const sqlArgs: any[] = [`${sessionId}%`];

	if (bus) {
		conditions.push("bus = ?");
		sqlArgs.push(bus);
	}
	if (typePattern) {
		conditions.push("type LIKE ?");
		sqlArgs.push(typePattern.replace(/\*/g, "%"));
	}
	if (errorsOnly) {
		conditions.push("(type LIKE '%error%' OR type LIKE '%fail%' OR json_extract(payload, '$.isError') = true)");
	}

	const sql = `
		SELECT bus, type, correlation_id, substr(payload, 1, 200) as payload_short, timestamp, elapsed
		FROM events
		WHERE ${conditions.join(" AND ")}
		ORDER BY timestamp
		LIMIT ?
	`;
	sqlArgs.push(limit);

	const result = await db.execute({ sql, args: sqlArgs });

	if (jsonOutput) {
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
		console.error("Usage: alef store trace <session-id> <correlationId>");
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
				console.log(`Tools:`);
				for (const t of tools) console.log(`  ${t.name}: ${t.calls} calls`);
			}
		} catch {
			// skip
		}
	}
}

async function tailLatest(db: Client, args: string[]): Promise<void> {
	const jsonOutput = args.includes("--json");

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

	await queryEvents(db, [sessionId, ...(jsonOutput ? ["--json"] : [])]);
}
