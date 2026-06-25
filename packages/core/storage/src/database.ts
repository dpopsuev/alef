import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { applySchema } from "./schema.js";

export type { Client };

export interface StorageConfig {
	backend?: "local" | "turso";
	tursoUrl?: string;
	tursoToken?: string;
	syncInterval?: number;
}

let _client: Client | undefined;
let _config: StorageConfig = {};

export function configureStorage(config: StorageConfig): void {
	_config = config;
}

export async function getDatabase(path?: string): Promise<Client> {
	if (_client) return _client;
	const dbPath = path ?? join(homedir(), ".alef", "alef.db");
	mkdirSync(dirname(dbPath), { recursive: true });

	if (_config.backend === "turso" && _config.tursoUrl) {
		_client = createClient({
			url: `file:${dbPath}`,
			syncUrl: _config.tursoUrl,
			authToken: _config.tursoToken ?? process.env.TURSO_AUTH_TOKEN,
			syncInterval: _config.syncInterval ?? 60,
		});
	} else {
		_client = createClient({ url: `file:${dbPath}` });
	}

	await _client.execute("PRAGMA journal_mode = WAL");
	await _client.execute("PRAGMA busy_timeout = 5000");
	await _client.execute("PRAGMA synchronous = NORMAL");
	await _client.execute("PRAGMA foreign_keys = ON");
	await applySchema(_client);
	return _client;
}

export function closeDatabase(): void {
	_client?.close();
	_client = undefined;
}

export async function syncDatabase(): Promise<void> {
	if (_client && "sync" in _client) {
		await (_client as Client & { sync(): Promise<void> }).sync();
	}
}

export async function openDatabase(path: string): Promise<Client> {
	mkdirSync(dirname(path), { recursive: true });
	const client = createClient({ url: `file:${path}` });
	await client.execute("PRAGMA journal_mode = WAL");
	await client.execute("PRAGMA busy_timeout = 5000");
	await client.execute("PRAGMA synchronous = NORMAL");
	await client.execute("PRAGMA foreign_keys = ON");
	await applySchema(client);
	return client;
}
