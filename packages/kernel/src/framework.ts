import type { ZodTypeAny } from "zod";
import { startElapsedTimer, withLimits } from "./budget.js";
import type { Nerve, Organ, ToolDefinition } from "./buses.js";
import { dispatchMotorAction, dispatchSenseAction } from "./organ-dispatch.js";
import type {
	ActionMap,
	CerebrumAction,
	CorpusAction,
	OrganLogger,
	OrganOptions,
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
	OrganOptions,
	StreamingCorpusAction,
} from "./organ-types.js";
export { typedAction, typedStreamAction } from "./organ-types.js";

const noopLogger: OrganLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
};

export { buildErrSense, buildSense, extractToolCallId, toErrorMessage } from "./sense-builders.js";

const BUS_PREFIXES = {
	motor: "motor/",
	sense: "sense/",
} as const;

function splitActionKey(key: string): { bus: "motor" | "sense"; eventType: string } | null {
	for (const [bus, prefix] of Object.entries(BUS_PREFIXES) as Array<["motor" | "sense", string]>) {
		if (key.startsWith(prefix)) return { bus, eventType: key.slice(prefix.length) };
	}
	return null;
}

function filterActions(actions: ActionMap, allowlist: readonly string[]): ActionMap {
	const allowed = new Set(allowlist);
	const filtered: ActionMap = {};
	for (const [key, action] of Object.entries(actions)) {
		const parsed = splitActionKey(key);
		if (parsed && allowed.has(parsed.eventType)) filtered[key] = action;
	}
	return filtered;
}

function extractToolsAndSubscriptions(actions: ActionMap): {
	tools: ToolDefinition[];
	motor: string[];
	sense: string[];
} {
	const tools: ToolDefinition[] = Object.values(actions)
		.filter((a) => "tool" in a && a.tool !== undefined)
		.map((a) => (a as { tool: ToolDefinition }).tool);
	const subs: Record<string, string[]> = { motor: [], sense: [] };
	for (const key of Object.keys(actions)) {
		const parsed = splitActionKey(key);
		if (parsed) subs[parsed.bus]?.push(parsed.eventType);
	}
	return { tools, motor: subs.motor, sense: subs.sense };
}

function buildMotorSchemas(actions: ActionMap, overrides?: Record<string, ZodTypeAny>): Record<string, ZodTypeAny> {
	const auto: Record<string, ZodTypeAny> = {};
	for (const [key, action] of Object.entries(actions)) {
		const parsed = splitActionKey(key);
		if (parsed?.bus === "motor") {
			const schema = (action as CorpusAction | StreamingCorpusAction).tool?.inputSchema;
			if (schema) auto[parsed.eventType] = schema;
		}
	}
	return { ...auto, ...overrides };
}

type BusDispatcher = (
	eventType: string,
	action: ActionMap[string],
	nerve: Nerve,
	cache: Map<string, Record<string, unknown>>,
	log: OrganLogger,
	schema: ZodTypeAny | undefined,
) => () => void;

const busDispatchers: Record<string, BusDispatcher> = {
	motor: (eventType, action, nerve, cache, log, schema) =>
		nerve.motor.subscribe(
			eventType,
			(event) =>
				void dispatchMotorAction(event, action as CorpusAction | StreamingCorpusAction, nerve, cache, log, schema),
		),
	sense: (eventType, action, nerve, _cache, log) =>
		nerve.sense.subscribe(eventType, (event) =>
			dispatchSenseAction(eventType, event, nerve, action as CerebrumAction, log),
		),
};

function validateOrganMetadata(name: string, tools: ToolDefinition[], opts: OrganOptions): void {
	if (tools.length === 0) return;
	if (!opts.description || opts.description.trim().length === 0)
		throw new Error(
			`[defineOrgan] '${name}' exposes ${tools.length} tool(s) but has no description. Add description: "One-sentence summary of what this organ does."`,
		);
	if (!opts.directives || opts.directives.length === 0)
		throw new Error(
			`[defineOrgan] '${name}' exposes ${tools.length} tool(s) but has no directives. Add directives: ["Guidance block telling the LLM how and when to use these tools."]`,
		);
	if (opts.directives.some((d) => d.trim().length < 20))
		throw new Error(
			`[defineOrgan] '${name}' has directive block(s) shorter than 20 chars. Each block must be meaningful guidance, not a placeholder.`,
		);
	const totalChars = opts.directives.reduce((n, d) => n + d.length, 0);
	if (totalChars > 2000)
		throw new Error(
			`[defineOrgan] '${name}' directives total ${totalChars} chars (max 2000). Keep guidance concise — the system prompt budget is shared across all organs.`,
		);
}

export function defineOrgan(name: string, actions: ActionMap, opts: OrganOptions = {}): Organ {
	const log = opts.logger ?? noopLogger;

	if (opts.actions !== undefined) actions = filterActions(actions, opts.actions);

	const { tools, motor: motorSubscriptions, sense: senseSubscriptions } = extractToolsAndSubscriptions(actions);
	validateOrganMetadata(name, tools, opts);

	return {
		name,
		tools,
		subscriptions: {
			motor: motorSubscriptions,
			sense: senseSubscriptions,
		},
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
		mount(rawNerve: Nerve): () => void {
			let nerve = rawNerve;
			if (opts.limits) nerve = withLimits(opts.limits)(nerve);
			for (const mw of opts.middlewares ?? []) nerve = mw(nerve);
			opts.onMount?.(nerve);
			const stopElapsedTimer = opts.limits ? startElapsedTimer(opts.limits, nerve) : undefined;
			const cache = new Map<string, Record<string, unknown>>();
			const motorInputSchemas = buildMotorSchemas(actions, opts.inputSchemas?.motor);

			const unsubs = Object.entries(actions).map(([prefixedKey, action]) => {
				const parsed = splitActionKey(prefixedKey);
				if (!parsed) {
					log.warn({ key: prefixedKey, organ: name }, "action key missing bus prefix, skipping");
					return () => {};
				}
				const dispatcher = busDispatchers[parsed.bus];
				if (!dispatcher) {
					log.warn({ key: prefixedKey, bus: parsed.bus, organ: name }, "no dispatcher for bus, skipping");
					return () => {};
				}
				return dispatcher(parsed.eventType, action, nerve, cache, log, motorInputSchemas[parsed.eventType]);
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
