import type { Client } from "@libsql/client";
const EMBEDDING_DIMENSION = 384;

export { EMBEDDING_DIMENSION };

export interface RecallResult {
	correlationId: string;
	type: string;
	similarity: number;
	timestamp: number;
}

export interface SessionRecallResult {
	sessionId: string;
	model: string;
	startedAt: string;
	turns: number;
	similarity: number;
}

export class RecallStore {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async setEventEmbedding(rowid: number, embedding: number[]): Promise<void> {
		await this.client.execute({
			sql: "UPDATE events SET embedding = vector32(?) WHERE rowid = ?",
			args: [JSON.stringify(embedding), rowid],
		});
	}

	async setSummaryEmbedding(sessionId: string, embedding: number[]): Promise<void> {
		await this.client.execute({
			sql: "UPDATE session_summaries SET embedding = vector32(?) WHERE session_id = ?",
			args: [JSON.stringify(embedding), sessionId],
		});
	}

	async searchEvents(sessionId: string, queryEmbedding: number[], limit = 20): Promise<RecallResult[]> {
		const result = await this.client.execute({
			sql: `SELECT correlation_id, type, timestamp,
					vector_distance_cos(embedding, vector32(?)) as dist
				FROM events
				WHERE session_id = ? AND embedding IS NOT NULL
				ORDER BY dist LIMIT ?`,
			args: [JSON.stringify(queryEmbedding), sessionId, limit],
		});

		return result.rows.map((r) => ({
			correlationId: String(r.correlation_id),
			type: String(r.type),
			similarity: 1 - Number(r.dist),
			timestamp: Number(r.timestamp),
		}));
	}

	async searchSessions(queryEmbedding: number[], limit = 10): Promise<SessionRecallResult[]> {
		const result = await this.client.execute({
			sql: `SELECT ss.session_id, ss.model, ss.started_at, ss.turns,
					vector_distance_cos(ss.embedding, vector32(?)) as dist
				FROM session_summaries ss
				WHERE ss.embedding IS NOT NULL
				ORDER BY dist LIMIT ?`,
			args: [JSON.stringify(queryEmbedding), limit],
		});

		return result.rows.map((r) => ({
			sessionId: String(r.session_id),
			model: String(r.model),
			startedAt: String(r.started_at),
			turns: Number(r.turns),
			similarity: 1 - Number(r.dist),
		}));
	}

	async turnScores(sessionId: string, queryEmbedding: number[], limit = 50): Promise<Map<string, number>> {
		const results = await this.searchEvents(sessionId, queryEmbedding, limit);
		const scores = new Map<string, number>();
		for (const r of results) {
			const current = scores.get(r.correlationId) ?? 0;
			if (r.similarity > current) scores.set(r.correlationId, r.similarity);
		}
		return scores;
	}
}
