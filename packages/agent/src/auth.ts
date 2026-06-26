import { getEnvApiKey } from "@dpopsuev/alef-llm/env";
import type { AuthStore } from "@dpopsuev/alef-storage";

let _store: AuthStore | undefined;
const _cache = new Map<string, string>();

export function setAuthStore(store: AuthStore): void {
	_store = store;
}

export async function warmAuthCache(): Promise<void> {
	if (!_store) return;
	const entries = await _store.list();
	for (const entry of entries) {
		const key = await _store.get(entry.provider);
		if (key) _cache.set(entry.provider, key);
	}
}

export function getStoredApiKey(provider: string): string | undefined {
	return _cache.get(provider);
}

export async function setStoredApiKey(provider: string, key: string): Promise<void> {
	_cache.set(provider, key);
	await _store?.set(provider, key);
}

export async function removeStoredApiKey(provider: string): Promise<void> {
	_cache.delete(provider);
	await _store?.remove(provider);
}

export function resolveApiKey(provider: string): string | undefined {
	return _cache.get(provider) ?? getEnvApiKey(provider) ?? undefined;
}
