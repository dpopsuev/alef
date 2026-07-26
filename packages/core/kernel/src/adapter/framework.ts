import { type ZodTypeAny, z } from "zod";
import { createMapCache, makeCacheKey } from "./cache.js";
import { dispatchCommandAction, dispatchEventAction } from "./dispatch.js";
import type { ActionMap, AdapterLogger, AdapterOptions, CommandActionMap, EventActionMap } from "./types.js";
import { startElapsedTimer, withLimits } from "../bus/budget.js";
import type { Adapter, ToolDefinition } from "./interface.js";
import type { Bus } from "../bus/messages.js";
import { CommandRouter, type CommandBinding, defineCommand } from "../capabilities.js";

export type {
	ActionMap,
	AdapterLogger,
	AdapterOptions,
	CommandAction,
	CommandActionMap,
	CommandHandlerCtx,
	EventAction,
	EventActionMap,
	EventHandlerCtx,
} from "./types.js";
export { typedAction, typedStreamAction } from "./types.js";

const noopLogger: AdapterLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
};

export { buildErrorResult, buildEventResult, extractToolCallId } from "../bus/event-builders.js";

/** Filter an action map to include only the event types present in the allowlist. */
function filterActions(actions: ActionMap, allowlist: readonly string[]): ActionMap {
	const allowed = new Set(allowlist);
	const filtered: ActionMap = {};
	if (actions.command) {
		const command: CommandActionMap = {};
		for (const [k, v] of Object.entries(actions.command)) {
			if (allowed.has(k)) command[k] = v;
		}
		if (Object.keys(command).length) filtered.command = command;
	}
	if (actions.event) {
		const event: EventActionMap = {};
		for (const [k, v] of Object.entries(actions.event)) {
			if (allowed.has(k)) event[k] = v;
		}
		if (Object.keys(event).length) filtered.event = event;
	}
	return filtered;
}

/** Extract tool definitions and subscription lists from an adapter's action map. */
function extractToolsAndSubscriptions(actions: ActionMap): {
	tools: ToolDefinition[];
	command: string[];
	event: string[];
} {
	const tools: ToolDefinition[] = Object.values(actions.command ?? {})
		.filter((a) => a.tool !== undefined)
		.map((a) => a.tool!);
	return {
		tools,
		command: Object.keys(actions.command ?? {}),
		event: Object.keys(actions.event ?? {}),
	};
}

/** Collect Zod input schemas from command actions, merging any caller-provided overrides. */
function buildCommandSchemas(actions: ActionMap, overrides?: Record<string, ZodTypeAny>): Record<string, ZodTypeAny> {
	const auto: Record<string, ZodTypeAny> = {};
	for (const [eventType, action] of Object.entries(actions.command ?? {})) {
		const schema = action.tool?.inputSchema;
		if (schema) auto[eventType] = schema;
	}
	return { ...auto, ...overrides };
}

const RECORD_SCHEMA = z.record(z.string(), z.unknown());

/** Keeps adapter-local cache state isolated to one materialized command router. */
function buildCommandBindings(
	actions: ActionMap,
	log: AdapterLogger,
	inputOverrides?: Record<string, ZodTypeAny>,
): CommandBinding[] {
	const inputSchemas = buildCommandSchemas(actions, inputOverrides);
	return Object.entries(actions.command ?? {}).map(([name, action]) => ({
		command: defineCommand({
			name,
			version: action.tool?.version ?? 1,
			input: inputSchemas[name] ?? RECORD_SCHEMA,
			output: action.tool?.outputSchema ?? RECORD_SCHEMA,
			permissions: action.tool?.permissions ?? [],
		}),
		bind() {
			const cache = createMapCache();
			return async ({ input, correlationId, toolCallId, reportProgress }) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Command input schemas for adapter actions produce object payloads.
				const payload = input as Record<string, unknown>;
				const context = {
					correlationId: correlationId ?? "",
					toolCallId,
					payload,
					log: log.child({ ...(correlationId ? { correlationId } : {}), ...(toolCallId ? { toolCallId } : {}) }),
				};
				const cacheKey = makeCacheKey(name, payload);
				const cached = cache.get(cacheKey);
				if (cached !== undefined) return cached;

				let last: Record<string, unknown> | undefined;
				for await (const chunk of action.handle(context)) {
					if (last !== undefined) reportProgress(last);
					last = chunk;
				}
				const result = last ?? {};
				if (action.invalidates) cache.invalidate(action.invalidates(context));
				if (action.shouldCache?.(context, result)) cache.set(cacheKey, result);
				return result;
			};
		},
	}));
}

/** Materializes command ownership before an AgentSession can execute tools. */
export function createAdapterCommandRouter(adapters: readonly Adapter[]): CommandRouter {
	const router = new CommandRouter();
	for (const adapter of adapters) {
		for (const binding of adapter.commands ?? []) router.registerBinding(adapter.name, binding);
	}
	return router;
}

/** Throw if an adapter exposes tools but is missing a description or directives. */
function validateAdapterMetadata(name: string, tools: ToolDefinition[], opts: AdapterOptions): void {
	if (tools.length === 0) return;
	if (!opts.description || opts.description.trim().length === 0)
		throw new Error(
			`[defineAdapter] '${name}' exposes ${tools.length} tool(s) but has no description. Add description: "One-sentence summary of what this adapter does."`,
		);
	if (!opts.directives || opts.directives.length === 0)
		throw new Error(
			`[defineAdapter] '${name}' exposes ${tools.length} tool(s) but has no directives. Add directives: ["Guidance block telling the LLM how and when to use these tools."]`,
		);
}

/** Construct an Adapter from a name, action map, and options, wiring subscriptions, caching, and bus dispatch. */
export function defineAdapter(name: string, actions: ActionMap, opts: AdapterOptions = {}): Adapter {
	const log = opts.logger ?? noopLogger;

	if (opts.actions !== undefined) actions = filterActions(actions, opts.actions);

	const { tools, command: commandSubscriptions, event: eventSubscriptions } = extractToolsAndSubscriptions(actions);
	validateAdapterMetadata(name, tools, opts);
	const commands = buildCommandBindings(actions, log, opts.inputSchemas?.command);

	return {
		name,
		tools,
		commands,
		subscriptions: {
			command: commandSubscriptions,
			event: eventSubscriptions,
			notification: [],
		},
		sources: opts.sources ?? [],
		directives: opts.directives,
		contributions: {
			...opts.contributions,
			...(opts.skills?.length ? { skills: opts.skills } : {}),
		},
		description: opts.description,
		labels: opts.labels,
		publishSchemas: opts.publishSchemas,
		inputSchemas: opts.inputSchemas,
		ready: opts.ready,
		mount(bus: Bus): () => void {
			let b = bus;
			if (opts.limits) b = withLimits(opts.limits)(b);
			for (const mw of opts.middlewares ?? []) b = mw(b);
			opts.onMount?.(b);
			const stopElapsedTimer = opts.limits ? startElapsedTimer(opts.limits, b) : undefined;
			const cache = createMapCache();
			const commandInputSchemas = buildCommandSchemas(actions, opts.inputSchemas?.command);

			const unsubs: Array<() => void> = [];

			for (const [eventType, action] of Object.entries(actions.command ?? {})) {
				unsubs.push(
					b.command.subscribe(eventType, (event) => {
						void dispatchCommandAction(event, action, b, cache, log, commandInputSchemas[eventType]);
					}),
				);
			}

			for (const [eventType, action] of Object.entries(actions.event ?? {})) {
				unsubs.push(b.event.subscribe(eventType, (event) => dispatchEventAction(eventType, event, b, action, log)));
			}

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
