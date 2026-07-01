import { getEnvApiKey } from "@dpopsuev/alef-ai/env";
import type { AuthStore } from "@dpopsuev/alef-storage";

let _store: AuthStore | undefined;
const _cache = new Map<string, string>();

/** Bind the persistent auth store used by warmAuthCache and credential writes. */
export function setAuthStore(store: AuthStore): void {
	_store = store;
}

/** Boot-time prefetch so resolveApiKey() never hits disk on the hot path. */
export async function warmAuthCache(): Promise<void> {
	if (!_store) return;
	const entries = await _store.list();
	for (const entry of entries) {
		const key = await _store.get(entry.provider);
		if (key) _cache.set(entry.provider, key);
	}
}

/** Cache-only lookup — call warmAuthCache() first or this always returns undefined. */
export function getStoredApiKey(provider: string): string | undefined {
	return _cache.get(provider);
}

/** Persist an API key for the given provider to both cache and backing store. */
export async function setStoredApiKey(provider: string, key: string): Promise<void> {
	_cache.set(provider, key);
	await _store?.set(provider, key);
}

/** Remove an API key from both the in-memory cache and the backing store. */
export async function removeStoredApiKey(provider: string): Promise<void> {
	_cache.delete(provider);
	await _store?.remove(provider);
}

/** Resolve an API key for the provider from cache, env var, or undefined. */
export function resolveApiKey(provider: string): string | undefined {
	return _cache.get(provider) ?? getEnvApiKey(provider) ?? undefined;
}
