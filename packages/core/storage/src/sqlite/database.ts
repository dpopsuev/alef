import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { databasePath, ensureAlefHome } from "@dpopsuev/alef-kernel/xdg";
import { type Client, createClient } from "@libsql/client";
import { applySchema } from "./schema.js";

const DEFAULT_SYNC_INTERVAL_S = 60;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export type { Client };

/**
 *
 */
export interface StorageConfig {
	backend?: "local" | "turso";
	tursoUrl?: string;
	tursoToken?: string;
	syncInterval?: number;
}

let _client: Client | undefined;
let _config: StorageConfig = {};

/**
 *
 */
export function configureStorage(config: StorageConfig): void {
	_config = config;
}

/**
 *
 */
export async function getDatabase(path?: string): Promise<Client> {
	if (_client) return _client;
	if (!path) ensureAlefHome();
	const dbPath = path ?? databasePath();
	mkdirSync(dirname(dbPath), { recursive: true });

	if (_config.backend === "turso" && _config.tursoUrl) {
		_client = createClient({
			url: `file:${dbPath}`,
			syncUrl: _config.tursoUrl,
			authToken: _config.tursoToken ?? process.env.TURSO_AUTH_TOKEN,
			syncInterval: _config.syncInterval ?? DEFAULT_SYNC_INTERVAL_S,
		});
	} else {
		_client = createClient({ url: `file:${dbPath}` });
	}

	await configurePragmas(_client);
	await applySchema(_client);
	return _client;
}

/**
 *
 */
export function setDatabase(client: Client): void {
	_client = client;
}

/**
 *
 */
export function closeDatabase(): void {
	_client?.close();
	_client = undefined;
}

/**
 *
 */
export async function syncDatabase(): Promise<void> {
	if (_client && "sync" in _client) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sync exists at runtime (Turso embedded replica)
		await (_client as Client & { sync(): Promise<void> }).sync();
	}
}

/**
 *
 */
async function configurePragmas(client: Client): Promise<void> {
	await client.execute("PRAGMA journal_mode = WAL");
	await client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	await client.execute("PRAGMA synchronous = NORMAL");
	await client.execute("PRAGMA foreign_keys = ON");
}

/**
 *
 */
export async function openDatabase(path: string): Promise<Client> {
	mkdirSync(dirname(path), { recursive: true });
	const client = createClient({ url: `file:${path}` });
	await configurePragmas(client);
	await applySchema(client);
	return client;
}

/**
 *
 */
export async function makeTestDatabase(): Promise<{ client: Client; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "alef-test-"));
	const client = await openDatabase(join(dir, "test.db"));
	return { client, cleanup: () => { client.close(); rmSync(dir, { recursive: true, force: true }); } };
}
