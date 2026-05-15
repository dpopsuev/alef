/**
 * Organ framework — defineOrgan / defineCorpusOrgan / defineCerebrumOrgan.
 *
 * Eliminates the four patterns every organ repeats:
 *   1. try/catch error wrapping
 *   2. nerve.motor/sense.subscribe loop
 *   3. return () => { unsub1(); unsub2(); ... }
 *   4. toolCallId mirroring to Sense
 *
 * Action map keys declare which bus to subscribe:
 *   "motor/fs.read"      → subscribes Motor, handles corpus-style actions
 *   "sense/dialog.message" → subscribes Sense, handles cerebrum-style actions
 *   "motor/*"            → wildcard: subscribes all Motor events (Observer organs)
 *   "sense/*"            → wildcard: subscribes all Sense events
 *
 * defineCorpusOrgan(name, actions) — prepends "motor/" to each key.
 * defineCerebrumOrgan(name, actions) — prepends "sense/" to each key.
 *
 * Cache (session-scoped per organ):
 *   CorpusAction.shouldCache?(ctx, result) → boolean  — called after handle(), opt-in
 *   CorpusAction.invalidates?(ctx) → string[]  — event-type prefixes to purge on write
 *   Cache key = "${eventType}:${stableHash(payload without toolCallId)}"
 *   StreamingCorpusAction: never cached.
 *
 * ROGYB logging (pino-compatible interface, no-op default):
 *   Orange: log.warn on handle() failures, cache miss on error path
 *   Yellow: log.debug on cache hits, successful dispatches
 */

import type { MotorEvent, Nerve, Organ, SenseEvent, ToolDefinition } from "./buses.js";

// ---------------------------------------------------------------------------
// Logger interface — pino-compatible. Pass a scoped pino instance in prod.
// ---------------------------------------------------------------------------

export interface OrganLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
}

const noopLogger: OrganLogger = {
	debug: () => {},
	warn: () => {},
};

// ---------------------------------------------------------------------------
// CorpusOrgan actions (Motor → handle/stream → Sense)
// ---------------------------------------------------------------------------

/** Context passed to every CorpusOrgan action handler. */
export interface CorpusHandlerCtx {
	/** Correlation ID from the Motor event — thread through to Sense. */
	readonly correlationId: string;
	/** toolCallId from Motor payload — mirrored to Sense payload for LLM correlation. */
	readonly toolCallId: string | undefined;
	/** The full Motor payload. */
	readonly payload: Record<string, unknown>;
}

/** Standard (non-streaming) CorpusOrgan action. Returns result payload or throws. */
export interface CorpusAction {
	/** Present → exposed as an LLM-callable tool. Absent → internal. */
	readonly tool?: ToolDefinition;
	handle(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>>;
	/**
	 * Called after handle() with the result. Return true to cache the result.
	 * Default: not cached. Implement for read-only idempotent actions (fs.read, web.fetch).
	 */
	shouldCache?(ctx: CorpusHandlerCtx, result: Record<string, unknown>): boolean;
	/**
	 * Called before Sense is published. Return event-type strings whose cache
	 * entries should be purged. All cache keys starting with "${type}:" are deleted.
	 * Implement for write-path actions (fs.edit, fs.write).
	 */
	invalidates?(ctx: CorpusHandlerCtx): string[];
}

/**
 * Streaming CorpusOrgan action — Channel pattern.
 * Yields partial payloads; framework emits each as a Sense event.
 * The last yielded value is marked isFinal: true.
 * Streaming actions are never cached.
 */
export interface StreamingCorpusAction {
	readonly tool?: ToolDefinition;
	stream(ctx: CorpusHandlerCtx): AsyncIterable<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// CerebrumOrgan actions (Sense → handle → Motor fan-out)
// ---------------------------------------------------------------------------

/** Context passed to every CerebrumOrgan action handler. */
export interface CerebrumHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	/** Publish Motor events — use for fan-out tool calls. */
	readonly motor: Nerve["motor"];
	/** Subscribe to Sense events — use for awaiting tool results. */
	readonly sense: Nerve["sense"];
}

/** One action a CerebrumOrgan handles. */
export interface CerebrumAction {
	handle(ctx: CerebrumHandlerCtx): Promise<void>;
}

// ---------------------------------------------------------------------------
// Unified action map — keys prefixed "motor/" or "sense/"
// ---------------------------------------------------------------------------

export type CorpusActionMap = Record<string, CorpusAction | StreamingCorpusAction>;
export type CerebrumActionMap = Record<string, CerebrumAction>;
export type ActionMap = Record<string, CorpusAction | StreamingCorpusAction | CerebrumAction>;

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function stableHash(payload: Record<string, unknown>): string {
	// Exclude toolCallId — it's per-call metadata, not part of the cache key.
	const keys = Object.keys(payload)
		.filter((k) => k !== "toolCallId")
		.sort();
	const sorted: Record<string, unknown> = {};
	for (const k of keys) sorted[k] = payload[k];
	return JSON.stringify(sorted);
}

function makeCacheKey(eventType: string, payload: Record<string, unknown>): string {
	return `${eventType}:${stableHash(payload)}`;
}

function invalidateByPrefix(cache: Map<string, Record<string, unknown>>, types: string[]): string[] {
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

// ---------------------------------------------------------------------------
// Sense builders (shared by framework and organs that need manual Sense)
// ---------------------------------------------------------------------------

function extractToolCallId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

export function buildSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

export function buildErrSense(motor: MotorEvent, message: string): SenseEvent {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

function isStreaming(action: CorpusAction | StreamingCorpusAction): action is StreamingCorpusAction {
	return "stream" in action;
}

async function dispatchMotorAction(
	motor: MotorEvent,
	action: CorpusAction | StreamingCorpusAction,
	nerve: Nerve,
	cache: Map<string, Record<string, unknown>>,
	log: OrganLogger,
): Promise<void> {
	const ctx: CorpusHandlerCtx = {
		correlationId: motor.correlationId,
		toolCallId: extractToolCallId(motor.payload),
		payload: motor.payload,
	};

	if (isStreaming(action)) {
		// Streaming path — emit chunks as Sense events; no caching.
		try {
			let last: Record<string, unknown> | undefined;
			for await (const chunk of action.stream(ctx)) {
				if (last !== undefined) {
					nerve.sense.publish(buildSense(motor, { ...last, isFinal: false }));
				}
				last = chunk;
			}
			if (last !== undefined) {
				nerve.sense.publish(buildSense(motor, { ...last, isFinal: true }));
			} else {
				nerve.sense.publish(buildSense(motor, { isFinal: true }));
			}
		} catch (e) {
			// Orange: streaming failure
			log.warn({ op: motor.type, correlationId: motor.correlationId, error: String(e) }, "stream action failed");
			nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
		}
		return;
	}

	// Standard (non-streaming) path.
	// Check cache first.
	const cacheKey = makeCacheKey(motor.type, motor.payload);
	const cached = cache.get(cacheKey);
	if (cached !== undefined) {
		// Yellow: cache hit — success signal
		log.debug({ op: motor.type, correlationId: motor.correlationId, cacheKey }, "cache hit");
		nerve.sense.publish(buildSense(motor, cached));
		return;
	}

	try {
		const result = await action.handle(ctx);

		// Invalidate BEFORE caching the new result (write-then-read order).
		if (action.invalidates) {
			const types = action.invalidates(ctx);
			const purged = invalidateByPrefix(cache, types);
			if (purged.length > 0) {
				// Yellow: invalidation — success signal for write path
				log.debug({ op: motor.type, correlationId: motor.correlationId, purged }, "cache invalidated");
			}
		}

		// Cache if action opts in.
		if (action.shouldCache?.(ctx, result)) {
			cache.set(cacheKey, result);
			// Yellow: cached result
			log.debug({ op: motor.type, correlationId: motor.correlationId, cacheKey }, "result cached");
		}

		nerve.sense.publish(buildSense(motor, result));
	} catch (e) {
		// Orange: handle() failure
		log.warn({ op: motor.type, correlationId: motor.correlationId, error: String(e) }, "corpus action failed");
		nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
	}
}

// ---------------------------------------------------------------------------
// defineOrgan — the primary factory
// ---------------------------------------------------------------------------

export interface OrganOptions {
	/** Pino-compatible logger. Default: no-op. */
	logger?: OrganLogger;
}

/**
 * defineOrgan — create an Organ from an action map where keys carry the bus prefix.
 *
 * "motor/fs.read"      → subscribes Motor bus for "fs.read" events.
 * "sense/dialog.message" → subscribes Sense bus for "dialog.message" events.
 * "motor/*"            → subscribes all Motor events (wildcard, for observers).
 * "sense/*"            → subscribes all Sense events.
 *
 * @example
 * ```ts
 * export const createFsOrgan = (opts: FsOrganOptions) =>
 *   defineOrgan("fs", {
 *     "motor/fs.read": { tool: FS_READ_TOOL, handle: (ctx) => readFile(ctx, opts), shouldCache: () => true },
 *     "motor/fs.edit": { tool: FS_EDIT_TOOL, handle: (ctx) => editFile(ctx, opts), invalidates: () => ["fs.read", "fs.grep"] },
 *   });
 * ```
 */
export function defineOrgan(name: string, actions: ActionMap, opts: OrganOptions = {}): Organ {
	const log = opts.logger ?? noopLogger;

	const tools: ToolDefinition[] = Object.values(actions)
		.filter((a) => "tool" in a && a.tool !== undefined)
		.map((a) => (a as { tool: ToolDefinition }).tool);

	return {
		name,
		tools,
		mount(nerve: Nerve): () => void {
			// Session-scoped cache — lives for the lifetime of this mount.
			const cache = new Map<string, Record<string, unknown>>();

			const unsubs = Object.entries(actions).map(([prefixedKey, action]) => {
				if (prefixedKey.startsWith("motor/")) {
					const eventType = prefixedKey.slice("motor/".length);
					const corpusAction = action as CorpusAction | StreamingCorpusAction;
					return nerve.motor.subscribe(
						eventType,
						(event) => void dispatchMotorAction(event, corpusAction, nerve, cache, log),
					);
				}
				if (prefixedKey.startsWith("sense/")) {
					const eventType = prefixedKey.slice("sense/".length);
					const cerebrumAction = action as CerebrumAction;
					return nerve.sense.subscribe(eventType, (event) => {
						const ctx: CerebrumHandlerCtx = {
							correlationId: event.correlationId,
							payload: event.payload,
							motor: nerve.motor,
							sense: nerve.sense,
						};
						void cerebrumAction.handle(ctx).catch((e) => {
							// Orange: cerebrum action failure (owns its own error handling)
							log.warn(
								{ op: eventType, correlationId: event.correlationId, error: String(e) },
								"cerebrum action failed",
							);
						});
					});
				}
				// Orange: misconfigured key — log and skip
				log.warn({ key: prefixedKey, organ: name }, "action key missing motor/ or sense/ prefix, skipping");
				return () => {};
			});

			return () => {
				for (const off of unsubs) off();
				cache.clear();
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * defineCorpusOrgan — prepends "motor/" to each action key.
 * Corpus organs subscribe Motor and publish Sense (they mutate the world).
 *
 * @example
 * ```ts
 * export const createFsOrgan = (opts: FsOrganOptions) =>
 *   defineCorpusOrgan("fs", {
 *     "fs.read": { tool: FS_READ_TOOL, handle: (ctx) => readFile(ctx, opts) },
 *     "fs.grep": { tool: FS_GREP_TOOL, handle: (ctx) => grepFiles(ctx, opts) },
 *   });
 * ```
 */
export function defineCorpusOrgan(name: string, actions: CorpusActionMap, opts: OrganOptions = {}): Organ {
	const prefixed: ActionMap = {};
	for (const [key, action] of Object.entries(actions)) {
		prefixed[`motor/${key}`] = action;
	}
	return defineOrgan(name, prefixed, opts);
}

/**
 * defineCerebrumOrgan — prepends "sense/" to each action key.
 * Cerebrum organs subscribe Sense and publish Motor (they mutate agent state).
 *
 * @example
 * ```ts
 * export const createLLMOrgan = (opts: LLMOrganOptions) =>
 *   defineCerebrumOrgan("llm", {
 *     "dialog.message": { handle: (ctx) => runLLMLoop(ctx, opts) },
 *   });
 * ```
 */
export function defineCerebrumOrgan(name: string, actions: CerebrumActionMap, opts: OrganOptions = {}): Organ {
	const prefixed: ActionMap = {};
	for (const [key, action] of Object.entries(actions)) {
		prefixed[`sense/${key}`] = action;
	}
	return defineOrgan(name, prefixed, opts);
}
