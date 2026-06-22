import type Database from "better-sqlite3";

export interface SessionSummary {
	id: string;
	model: string;
	started_at: string;
	duration_ms: number;
	turns: number;
	tokens: { input: number; output: number };
	tools: Array<{ name: string; calls: number }>;
	errors: number;
}

export class SqliteSummaryStore {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	write(summary: SessionSummary): void {
		this.db
			.prepare(
				`INSERT INTO session_summaries (session_id, model, started_at, duration_ms, turns,
				   input_tokens, output_tokens, tools, errors)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				   model = excluded.model, started_at = excluded.started_at,
				   duration_ms = excluded.duration_ms, turns = excluded.turns,
				   input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
				   tools = excluded.tools, errors = excluded.errors`,
			)
			.run(
				summary.id,
				summary.model,
				summary.started_at,
				summary.duration_ms,
				summary.turns,
				summary.tokens.input,
				summary.tokens.output,
				JSON.stringify(summary.tools),
				summary.errors,
			);
	}

	get(sessionId: string): SessionSummary | undefined {
		const row = this.db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(sessionId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return undefined;
		return {
			id: row.session_id as string,
			model: row.model as string,
			started_at: row.started_at as string,
			duration_ms: row.duration_ms as number,
			turns: row.turns as number,
			tokens: { input: row.input_tokens as number, output: row.output_tokens as number },
			tools: JSON.parse(row.tools as string) as Array<{ name: string; calls: number }>,
			errors: row.errors as number,
		};
	}

	latest(): SessionSummary | undefined {
		const row = this.db
			.prepare(
				"SELECT ss.* FROM session_summaries ss JOIN sessions s ON ss.session_id = s.id ORDER BY s.updated_at DESC LIMIT 1",
			)
			.get() as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return this.get(row.session_id as string);
	}
}
