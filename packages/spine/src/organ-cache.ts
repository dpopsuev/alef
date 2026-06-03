export function stableHash(payload: Record<string, unknown>): string {
	// Exclude toolCallId — it's per-call metadata, not part of the cache key.
	const keys = Object.keys(payload)
		.filter((k) => k !== "toolCallId")
		.sort();
	const sorted: Record<string, unknown> = {};
	for (const k of keys) sorted[k] = payload[k];
	return JSON.stringify(sorted);
}

export function makeCacheKey(eventType: string, payload: Record<string, unknown>): string {
	return `${eventType}:${stableHash(payload)}`;
}

export function invalidateByPrefix(cache: Map<string, Record<string, unknown>>, types: string[]): string[] {
	const invalidated: string[] = [];
	for (const type of types) {
		const prefix = `${type}:`;
		for (const key of [...cache.keys()]) {
			if (key.startsWith(prefix)) {
				cache.delete(key);
				invalidated.push(key);
			}
		}
	}
	return invalidated;
}
