/**
 * Organ framework — defineOrgan with explicit motor/ or sense/ prefixed action keys.
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

import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ZodTypeAny } from "zod";
import type { Budget } from "./budget.js";
import { startElapsedTimer, withLimits } from "./budget.js";
import type { Nerve, NerveMiddleware, Organ, ToolDefinition } from "./buses.js";
import { dispatchMotorAction } from "./organ-dispatch.js";
import type {
	ActionMap,
	CerebrumAction,
	CerebrumHandlerCtx,
	CorpusAction,
	OrganLogger,
	StreamingCorpusAction,
} from "./organ-types.js";

export type {
	ActionMap,
	CerebrumAction,
	CerebrumActionMap,
	CerebrumHandlerCtx,
	CorpusAction,
	CorpusActionMap,
	CorpusHandlerCtx,
	OrganLogger,
	StreamingCorpusAction,
} from "./organ-types.js";
export { typedAction, typedStreamAction } from "./organ-types.js";

const tracer = trace.getTracer("alef.spine", "0.0.1");

const noopLogger: OrganLogger = {
	debug: () => {},
	warn: () => {},
};

export { buildErrSense, buildSense, extractToolCallId } from "./sense-builders.js";

function splitActionKey(key: string): { bus: "motor" | "sense"; eventType: string } | null {
	if (key.startsWith("motor/")) return { bus: "motor", eventType: key.slice("motor/".length) };
	if (key.startsWith("sense/")) return { bus: "sense", eventType: key.slice("sense/".length) };
	return null;
}

// ---------------------------------------------------------------------------
// defineOrgan — the primary factory
// ---------------------------------------------------------------------------

export interface OrganOptions {
	/** Pino-compatible logger. Default: no-op. */
	logger?: OrganLogger;
	/**
	 * Allowlist of unprefixed event types to mount (e.g. ['fs.read', 'fs.grep']).
	 * Actions not in the list are never constructed, never mounted on the bus,
	 * and never appear in organ.tools — principle of least privilege.
	 * Default: undefined (all actions mounted).
	 *
	 * Use this to implement blueprint action ablation: only mount what the
	 * blueprint declares, so the agent cannot call tools it was not given.
	 */
	actions?: readonly string[];
	/**
	 * ACI directives injected into the system prompt by DirectiveContextAssembler.
	 * Each string is a guidance block (prose or markdown) telling the LLM when,
	 * how, and when NOT to use this organ's tools.
	 */
	directives?: readonly string[];
	/** Short human-readable description shown in --list-organs and diagnostics. */
	description?: string;
	/** Freeform labels for categorisation and discovery (e.g. ['filesystem', 'readonly']). */
	labels?: readonly string[];
	/** Zod payload schemas validated at publish time in non-production environments. */
	publishSchemas?: {
		motor?: Record<string, ZodTypeAny>;
		sense?: Record<string, ZodTypeAny>;
	};
	/**
	 * Zod schemas for incoming motor event payloads, validated before dispatch.
	 * Complement to publishSchemas: catches malformed tool calls from the LLM
	 * before they reach the handler. A failure publishes an error sense response.
	 * Active only when ALEF_VALIDATE_PAYLOADS=1 or NODE_ENV=test.
	 */
	inputSchemas?: {
		motor?: Record<string, ZodTypeAny>;
	};
	/** Async initialization called by Agent.ready() before the first event is routed. */
	ready?: () => Promise<void>;
	/**
	 * Called when the organ is unmounted (agent.dispose or hot-reload).
	 * Use for cleanup that the organ's action handlers cannot do themselves:
	 * cache clearing, LSP shutdown, child process termination.
	 * Eliminates the need to monkey-patch the returned Organ object.
	 */
	onUnmount?: () => void;
	/**
	 * Hard resource limits enforced by middleware before the organ handles any event.
	 * The LLM never sees these — they are enforced transparently.
	 */
	limits?: Budget;
	/**
	 * Composable nerve middleware applied to the organ's nerve during mount().
	 * Applied after limits, in array order (first = outermost wrapper).
	 */
	middlewares?: NerveMiddleware[];
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

	// Apply action allowlist — ablate anything not in the list.
	// Unknown names in the allowlist are ignored (forward-compat, not an error).
	if (opts.actions !== undefined) {
		const allowed = new Set(opts.actions);
		const filtered: ActionMap = {};
		for (const [key, action] of Object.entries(actions)) {
			const parsed = splitActionKey(key);
			if (parsed && allowed.has(parsed.eventType)) {
				filtered[key] = action;
			}
		}
		actions = filtered;
	}

	const tools: ToolDefinition[] = Object.values(actions)
		.filter((a) => "tool" in a && a.tool !== undefined)
		.map((a) => (a as { tool: ToolDefinition }).tool);

	// Derive subscriptions from action map keys for SeamRegistry detection.
	const motorSubscriptions: string[] = [];
	const senseSubscriptions: string[] = [];
	for (const key of Object.keys(actions)) {
		const parsed = splitActionKey(key);
		if (parsed?.bus === "motor") motorSubscriptions.push(parsed.eventType);
		else if (parsed?.bus === "sense") senseSubscriptions.push(parsed.eventType);
	}

	// Validate context metadata for tool-bearing organs.
	// Organs with no tools are exempt from the directive requirement.
	if (tools.length > 0) {
		if (!opts.description || opts.description.trim().length === 0) {
			throw new Error(
				`[defineOrgan] '${name}' exposes ${tools.length} tool(s) but has no description. ` +
					`Add description: "One-sentence summary of what this organ does."`,
			);
		}
		if (!opts.directives || opts.directives.length === 0) {
			throw new Error(
				`[defineOrgan] '${name}' exposes ${tools.length} tool(s) but has no directives. ` +
					`Add directives: ["Guidance block telling the LLM how and when to use these tools."]`,
			);
		}
		const shortBlocks = opts.directives.filter((d) => d.trim().length < 20);
		if (shortBlocks.length > 0) {
			throw new Error(
				`[defineOrgan] '${name}' has directive block(s) shorter than 20 chars. ` +
					`Each block must be meaningful guidance, not a placeholder.`,
			);
		}
		const totalChars = opts.directives.reduce((n, d) => n + d.length, 0);
		if (totalChars > 2000) {
			throw new Error(
				`[defineOrgan] '${name}' directives total ${totalChars} chars (max 2000). ` +
					`Keep guidance concise — the system prompt budget is shared across all organs.`,
			);
		}
	}

	return {
		name,
		tools,
		subscriptions: {
			motor: motorSubscriptions,
			sense: senseSubscriptions,
		},
		directives: opts.directives,
		description: opts.description,
		labels: opts.labels,
		publishSchemas: opts.publishSchemas,
		inputSchemas: opts.inputSchemas,
		ready: opts.ready,
		mount(rawNerve: Nerve): () => void {
			let nerve = rawNerve;
			if (opts.limits) nerve = withLimits(opts.limits)(nerve);
			for (const mw of opts.middlewares ?? []) nerve = mw(nerve);
			const stopElapsedTimer = opts.limits ? startElapsedTimer(opts.limits, nerve) : undefined;
			const cache = new Map<string, Record<string, unknown>>();

			// Auto-build inputSchemas from tool definitions — organs don't need to
			// declare them separately. Explicit opts.inputSchemas.motor takes precedence.
			// Lex SOLID-O: new organs get validation for free without modifying framework.
			const autoMotorSchemas: Record<string, ZodTypeAny> = {};
			for (const [key, action] of Object.entries(actions)) {
				const parsed = splitActionKey(key);
				if (parsed?.bus === "motor") {
					const schema = (action as CorpusAction | StreamingCorpusAction).tool?.inputSchema;
					if (schema) autoMotorSchemas[parsed.eventType] = schema;
				}
			}
			const motorInputSchemas: Record<string, ZodTypeAny> = {
				...autoMotorSchemas,
				...opts.inputSchemas?.motor,
			};

			const unsubs = Object.entries(actions).map(([prefixedKey, action]) => {
				const parsed = splitActionKey(prefixedKey);
				if (parsed?.bus === "motor") {
					const { eventType } = parsed;
					const corpusAction = action as CorpusAction | StreamingCorpusAction;
					return nerve.motor.subscribe(
						eventType,
						(event) =>
							void dispatchMotorAction(event, corpusAction, nerve, cache, log, motorInputSchemas[eventType]),
					);
				}
				if (parsed?.bus === "sense") {
					const { eventType } = parsed;
					const cerebrumAction = action as CerebrumAction;
					return nerve.sense.subscribe(eventType, (event) => {
						const ctx: CerebrumHandlerCtx = {
							correlationId: event.correlationId,
							payload: event.payload,
							motor: nerve.motor,
							sense: nerve.sense,
						};
						// CONSUMER span wraps the cerebrum handler.
						const span = tracer.startSpan(`alef.sense/${eventType}`, {
							kind: SpanKind.CONSUMER,
							attributes: {
								"alef.event.type": eventType,
								"alef.correlation.id": event.correlationId,
							},
						});
						void context.with(trace.setSpan(context.active(), span), () =>
							cerebrumAction
								.handle(ctx)
								.then(() => span.setStatus({ code: SpanStatusCode.OK }))
								.catch((e: unknown) => {
									log.warn(
										{ op: eventType, correlationId: event.correlationId, error: String(e) },
										"cerebrum action failed",
									);
									span.recordException(e instanceof Error ? e : new Error(String(e)));
									span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
								})
								.finally(() => span.end()),
						);
					});
				}
				log.warn({ key: prefixedKey, organ: name }, "action key missing motor/ or sense/ prefix, skipping");
				return () => {};
			});

			return () => {
				for (const off of unsubs) off();
				stopElapsedTimer?.();
				cache.clear();
				opts.onUnmount?.();
			};
		},
	};
}

// ---------------------------------------------------------------------------
