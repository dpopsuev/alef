import type { Client } from "@libsql/client";
import type { AuthStore } from "../interfaces.js";

/**
 *
 */
export class SqliteAuthStore implements AuthStore {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async get(provider: string): Promise<string | undefined> {
		const result = await this.client.execute({
			sql: "SELECT key FROM auth WHERE provider = ?",
			args: [provider],
		});
		const row = result.rows[0];
		return row && typeof row.key === "string" ? row.key : undefined;
	}

	async set(provider: string, key: string): Promise<void> {
		await this.client.execute({
			sql: "INSERT INTO auth (provider, type, key) VALUES (?, 'api_key', ?) ON CONFLICT(provider) DO UPDATE SET key = excluded.key",
			args: [provider, key],
		});
	}

	async remove(provider: string): Promise<void> {
		await this.client.execute({
			sql: "DELETE FROM auth WHERE provider = ?",
			args: [provider],
		});
	}

	async list(): Promise<Array<{ provider: string; type: string }>> {
		const result = await this.client.execute({
			sql: "SELECT provider, type FROM auth ORDER BY provider",
			args: [],
		});
		return result.rows.map((r) => ({
			provider: typeof r.provider === "string" ? r.provider : "",
			type: typeof r.type === "string" ? r.type : "",
		}));
	}
}
