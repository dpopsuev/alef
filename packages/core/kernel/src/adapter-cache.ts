export interface CacheStrategy {
	get(key: string): Record<string, unknown> | undefined;
	set(key: string, value: Record<string, unknown>): void;
	invalidate(prefixes: string[]): string[];
	clear(): void;
}

function stableHash(payload: Record<string, unknown>): string {
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

export function createMapCache(): CacheStrategy {
	const store = new Map<string, Record<string, unknown>>();
	return {
		get: (key) => store.get(key),
		set: (key, value) => store.set(key, value),
		invalidate(prefixes) {
			const invalidated: string[] = [];
			for (const type of prefixes) {
				const prefix = `${type}:`;
				for (const key of [...store.keys()]) {
					if (key.startsWith(prefix)) {
						store.delete(key);
						invalidated.push(key);
					}
				}
			}
			return invalidated;
		},
		clear: () => store.clear(),
	};
}
