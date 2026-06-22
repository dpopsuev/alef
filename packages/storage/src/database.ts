import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { applySchema } from "./schema.js";

export type { Client };

let _client: Client | undefined;

export async function getDatabase(path?: string): Promise<Client> {
	if (_client) return _client;
	const dbPath = path ?? join(homedir(), ".alef", "alef.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	_client = createClient({ url: `file:${dbPath}` });
	await _client.execute("PRAGMA foreign_keys = ON");
	await applySchema(_client);
	return _client;
}

export function closeDatabase(): void {
	_client?.close();
	_client = undefined;
}

export async function openDatabase(path: string): Promise<Client> {
	mkdirSync(dirname(path), { recursive: true });
	const client = createClient({ url: `file:${path}` });
	await client.execute("PRAGMA foreign_keys = ON");
	await applySchema(client);
	return client;
}
