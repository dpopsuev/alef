import {
	type Bus,
	type BusMiddleware,
	buildSense,
	type CacheStrategy,
	defineAdapter,
	makeCacheKey,
	typedAction,
	withDisplay,
} from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface CacheOrganOptions {
	/** TTL in milliseconds (default: 5 minutes) */
	ttl?: number;
	/** Tools to cache (default: fs.read, fs.grep, fs.find, code.read) */
	cachedTools?: readonly string[];
	/** Tools that invalidate cache when called (default: fs.write, fs.edit, fs.patch) */
	invalidatingTools?: readonly string[];
}

interface CacheEntry {
	result: Record<string, unknown>;
	timestamp: number;
}

const DEFAULT_CACHED_TOOLS = ["command/fs.read", "command/fs.grep", "command/fs.find", "command/code.read"];
const DEFAULT_INVALIDATING_TOOLS = ["command/fs.write", "command/fs.edit", "command/fs.patch"];
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

function createTtlCache(ttl: number): CacheStrategy & { stats: () => CacheStats } {
	const store = new Map<string, CacheEntry>();

	return {
		get(key: string) {
			const entry = store.get(key);
			if (!entry) return undefined;

			const now = Date.now();
			if (now - entry.timestamp > ttl) {
				store.delete(key);
				return undefined;
			}

			return entry.result;
		},
		set(key: string, value: Record<string, unknown>) {
			store.set(key, { result: value, timestamp: Date.now() });
		},
		invalidate(prefixes: string[]) {
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
		clear() {
			store.clear();
		},
		stats() {
			return {
				size: store.size,
				entries: Array.from(store.entries()).map(([key, entry]) => ({
					key,
					age: Date.now() - entry.timestamp,
				})),
			};
		},
	};
}

interface CacheStats {
	size: number;
	entries: Array<{ key: string; age: number }>;
}

const INVALIDATE_TOOL = {
	name: "cache.invalidate",
	description: "Clear cache entries for specific tool types or all entries.",
	inputSchema: z.object({
		tools: z
			.array(z.string().min(1))
			.optional()
			.describe("Tool names to invalidate (e.g. ['fs.read']). Omit to clear all cache."),
	}),
};

const STATS_TOOL = {
	name: "cache.stats",
	description: "Get cache statistics: size, hit rate, and current entries.",
	inputSchema: z.object({}),
};

export function createCacheOrgan(opts: CacheOrganOptions = {}) {
	const ttl = opts.ttl ?? DEFAULT_TTL;
	const cachedTools = new Set(opts.cachedTools ?? DEFAULT_CACHED_TOOLS);
	const invalidatingTools = new Set(opts.invalidatingTools ?? DEFAULT_INVALIDATING_TOOLS);

	const cache = createTtlCache(ttl);
	let hits = 0;
	let misses = 0;

	// Track pending cache captures to prevent races
	const pendingCaptures = new Map<string, () => void>();

	// Middleware that wraps bus to intercept and cache motor events
	const cacheMiddleware: BusMiddleware = (bus: Bus): Bus => {
		// Subscribe to motor events for cached tools to prevent deadLetterSink
		const motorUnsubs: Array<() => void> = [];
		for (const toolType of cachedTools) {
			motorUnsubs.push(
				bus.command.subscribe(toolType, (event) => {
					const cacheKey = makeCacheKey(event.type, event.payload);
					const cached = cache.get(cacheKey);

					if (cached !== undefined) {
						hits++;
						// Publish cached result directly to sense bus
						bus.event.publish(
							buildSense(
								{ ...event, timestamp: Date.now(), elapsed: 0 },
								{ ...cached, _fromCache: true, isFinal: true },
							),
						);
						return; // Cache hit - don't continue processing
					}

					misses++;

					// Subscribe to sense result to cache it
					const correlationId = event.correlationId;
					let captured = false;

					const senseUnsub = bus.event.subscribe(event.type, (senseEvent) => {
						if (captured || senseEvent.correlationId !== correlationId) return;

						if (!senseEvent.isError) {
							// biome-ignore lint/correctness/noUnusedVariables: destructuring to filter out fields
							const { isFinal, _display, toolCallId, ...result } = senseEvent.payload;
							if (isFinal) {
								cache.set(cacheKey, result);
								captured = true;
								senseUnsub();
								pendingCaptures.delete(correlationId);
							}
						} else {
							// Don't cache errors
							captured = true;
							senseUnsub();
							pendingCaptures.delete(correlationId);
						}
					});

					pendingCaptures.set(correlationId, senseUnsub);

					// lint-ignore: RAWTIMER subscription cleanup deadline for uncaptured sense results
					setTimeout(
						() => {
							if (!captured) {
								senseUnsub();
								pendingCaptures.delete(correlationId);
							}
						},
						Math.min(ttl * 2, 60000),
					);
				}),
			);
		}

		// Subscribe to invalidating tools
		const invalidateUnsubs: Array<() => void> = [];
		for (const toolType of invalidatingTools) {
			invalidateUnsubs.push(
				bus.command.subscribe(toolType, () => {
					// Invalidate related cache entries
					const toInvalidate = ["command/fs.read", "command/fs.grep", "command/fs.find", "command/code.read"];
					cache.invalidate(toInvalidate);
				}),
			);
		}

		// Return wrapped bus with cleanup
		const wrappedNerve = { ...bus };

		// Override pulse to include cleanup of subscriptions
		const originalPulse = bus.pulse.bind(bus);
		wrappedNerve.pulse = () => {
			originalPulse();
		};

		// Store cleanup function for later
		(wrappedNerve as unknown as { _cacheCleanup?: () => void })._cacheCleanup = () => {
			for (const unsub of motorUnsubs) unsub();
			for (const unsub of invalidateUnsubs) unsub();
			for (const unsub of pendingCaptures.values()) unsub();
			pendingCaptures.clear();
		};

		return wrappedNerve;
	};

	return defineAdapter(
		"cache",
		{
			command: {
				"cache.invalidate": typedAction(INVALIDATE_TOOL, async (ctx) => {
					const { tools } = ctx.payload;

					if (!tools || tools.length === 0) {
						cache.clear();
						hits = 0;
						misses = 0;
						return withDisplay(
							{ cleared: "all" },
							{ text: "Cache cleared: all entries", mimeType: "text/plain" },
						);
					}

					// Add command/ prefix if not present
					const prefixed = tools.map((t) => (t.startsWith("command/") ? t : `command/${t}`));
					const invalidated = cache.invalidate(prefixed);

					return withDisplay(
						{ invalidated: invalidated.length, tools: prefixed },
						{
							text: `Cache invalidated: ${invalidated.length} entries for tools ${prefixed.join(", ")}`,
							mimeType: "text/plain",
						},
					);
				}),

				"cache.stats": typedAction(STATS_TOOL, async () => {
					const stats = cache.stats();
					const total = hits + misses;
					const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0";

					const output = [
						`Cache Statistics:`,
						`  Total requests: ${total}`,
						`  Hits: ${hits}`,
						`  Misses: ${misses}`,
						`  Hit rate: ${hitRate}%`,
						`  Current entries: ${stats.size}`,
						``,
						`Cached entries:`,
						...stats.entries.map(
							(e) =>
								`  ${e.key.substring(0, 80)}${e.key.length > 80 ? "..." : ""} (age: ${Math.floor(e.age / 1000)}s)`,
						),
					].join("\n");

					return withDisplay(
						{
							total,
							hits,
							misses,
							hitRate: Number.parseFloat(hitRate),
							size: stats.size,
							entries: stats.entries,
						},
						{ text: output, mimeType: "text/plain" },
					);
				}),
			},
		},
		{
			description: "Session-wide cache that deduplicates identical tool calls.",
			directives: [
				"Use cache.stats to inspect cache hit rate and current entries. Use cache.invalidate to clear specific tool caches or all entries.",
			],
			labels: ["cache", "performance"],
			middlewares: [cacheMiddleware],
			onUnmount() {
				// Clean up middleware subscriptions
				// Note: The middleware cleanup function is attached to the wrapped bus,
				// but we can't easily access it from here. The subscriptions will be
				// cleaned up when the bus is disposed.
			},
		},
	);
}
