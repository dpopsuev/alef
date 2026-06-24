import type { Client } from "@libsql/client";
import type { SummaryStore } from "./interfaces.js";

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

export class SqliteSummaryStore implements SummaryStore {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async write(summary: SessionSummary): Promise<void> {
		await this.client.execute({
			sql: `INSERT INTO session_summaries (session_id, model, started_at, duration_ms, turns,
				   input_tokens, output_tokens, tools, errors)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				   model = excluded.model, started_at = excluded.started_at,
				   duration_ms = excluded.duration_ms, turns = excluded.turns,
				   input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
				   tools = excluded.tools, errors = excluded.errors`,
			args: [
				summary.id,
				summary.model,
				summary.started_at,
				summary.duration_ms,
				summary.turns,
				summary.tokens.input,
				summary.tokens.output,
				JSON.stringify(summary.tools),
				summary.errors,
			],
		});
	}

	async get(sessionId: string): Promise<SessionSummary | undefined> {
		const result = await this.client.execute({
			sql: "SELECT * FROM session_summaries WHERE session_id = ?",
			args: [sessionId],
		});
		const row = result.rows[0];
		if (!row) return undefined;
		return {
			id: String(row.session_id),
			model: String(row.model),
			started_at: String(row.started_at),
			duration_ms: Number(row.duration_ms),
			turns: Number(row.turns),
			tokens: { input: Number(row.input_tokens), output: Number(row.output_tokens) },
			tools: JSON.parse(String(row.tools)) as Array<{ name: string; calls: number }>,
			errors: Number(row.errors),
		};
	}

	async latest(): Promise<SessionSummary | undefined> {
		const result = await this.client.execute({
			sql: "SELECT ss.* FROM session_summaries ss JOIN sessions s ON ss.session_id = s.id ORDER BY s.updated_at DESC LIMIT 1",
			args: [],
		});
		const row = result.rows[0];
		if (!row) return undefined;
		return this.get(String(row.session_id));
	}
}
