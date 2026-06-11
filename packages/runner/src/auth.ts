/**
 * File-based credential storage for the runner.
 *
 * Reads and writes ~/.config/alef/auth.json (XDG) or
 * the path set via XDG_CONFIG_HOME.
 *
 * Key resolution order for a provider:
 *   1. Stored key in auth.json
 *   2. Environment variable (via getEnvApiKey from @dpopsuev/alef-llm)
 *
 * No file locking — the runner is a single process.
 * No OAuth — that comes later.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getEnvApiKey } from "@dpopsuev/alef-llm";

type StoredApiKeyCredential = { type: "api_key"; key: string };
type StoredCredential = StoredApiKeyCredential;
type AuthData = Record<string, StoredCredential>;

export function authFilePath(): string {
	const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "alef", "auth.json");
}

function read(): AuthData {
	const path = authFilePath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AuthData;
	} catch {
		return {};
	}
}

function write(data: AuthData): void {
	const path = authFilePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** Get the stored API key for a provider, if any. */
export function getStoredApiKey(provider: string): string | undefined {
	const cred = read()[provider];
	return cred?.type === "api_key" ? cred.key : undefined;
}

/** Persist an API key for a provider to auth.json. */
export function setStoredApiKey(provider: string, key: string): void {
	const data = read();
	data[provider] = { type: "api_key", key };
	write(data);
}

/** Remove stored credentials for a provider. */
export function removeStoredApiKey(provider: string): void {
	const data = read();
	delete data[provider];
	write(data);
}

/**
 * Resolve the API key for a provider.
 * Checks auth.json first, then falls back to env vars.
 */
export function resolveApiKey(provider: string): string | undefined {
	return getStoredApiKey(provider) ?? getEnvApiKey(provider) ?? undefined;
}
