import type { ZodTypeAny } from "zod";
import { createMapCache } from "./cache.js";
import { dispatchCommandAction, dispatchEventAction } from "./dispatch.js";
import type { ActionMap, AdapterLogger, AdapterOptions, CommandActionMap, EventActionMap } from "./types.js";
import { startElapsedTimer, withLimits } from "../bus/budget.js";
import type { Adapter, ToolDefinition } from "./interface.js";
import type { Bus } from "../bus/messages.js";

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

export { buildErrSense, buildSense, extractToolCallId, toErrorMessage } from "../bus/event-builders.js";

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

function buildCommandSchemas(actions: ActionMap, overrides?: Record<string, ZodTypeAny>): Record<string, ZodTypeAny> {
	const auto: Record<string, ZodTypeAny> = {};
	for (const [eventType, action] of Object.entries(actions.command ?? {})) {
		const schema = action.tool?.inputSchema;
		if (schema) auto[eventType] = schema;
	}
	return { ...auto, ...overrides };
}

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

	return {
		name,
		tools,
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
