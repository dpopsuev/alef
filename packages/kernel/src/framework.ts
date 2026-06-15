import type { ZodTypeAny } from "zod";
import { startElapsedTimer, withLimits } from "./budget.js";
import type { Nerve, Organ, ToolDefinition } from "./buses.js";
import { createMapCache } from "./organ-cache.js";
import { dispatchMotorAction, dispatchSenseAction } from "./organ-dispatch.js";
import type { ActionMap, MotorActionMap, OrganLogger, OrganOptions, SenseActionMap } from "./organ-types.js";

export type {
	ActionMap,
	MotorAction,
	MotorActionMap,
	MotorHandlerCtx,
	OrganLogger,
	OrganOptions,
	SenseAction,
	SenseActionMap,
	SenseHandlerCtx,
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

function filterActions(actions: ActionMap, allowlist: readonly string[]): ActionMap {
	const allowed = new Set(allowlist);
	const filtered: ActionMap = {};
	if (actions.motor) {
		const motor: MotorActionMap = {};
		for (const [k, v] of Object.entries(actions.motor)) {
			if (allowed.has(k)) motor[k] = v;
		}
		if (Object.keys(motor).length) filtered.motor = motor;
	}
	if (actions.sense) {
		const sense: SenseActionMap = {};
		for (const [k, v] of Object.entries(actions.sense)) {
			if (allowed.has(k)) sense[k] = v;
		}
		if (Object.keys(sense).length) filtered.sense = sense;
	}
	return filtered;
}

function extractToolsAndSubscriptions(actions: ActionMap): {
	tools: ToolDefinition[];
	motor: string[];
	sense: string[];
} {
	const tools: ToolDefinition[] = Object.values(actions.motor ?? {})
		.filter((a) => a.tool !== undefined)
		.map((a) => a.tool as ToolDefinition);
	return {
		tools,
		motor: Object.keys(actions.motor ?? {}),
		sense: Object.keys(actions.sense ?? {}),
	};
}

function buildMotorSchemas(actions: ActionMap, overrides?: Record<string, ZodTypeAny>): Record<string, ZodTypeAny> {
	const auto: Record<string, ZodTypeAny> = {};
	for (const [eventType, action] of Object.entries(actions.motor ?? {})) {
		const schema = action.tool?.inputSchema;
		if (schema) auto[eventType] = schema;
	}
	return { ...auto, ...overrides };
}

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
			const cache = createMapCache();
			const motorInputSchemas = buildMotorSchemas(actions, opts.inputSchemas?.motor);

			const unsubs: Array<() => void> = [];

			for (const [eventType, action] of Object.entries(actions.motor ?? {})) {
				unsubs.push(
					nerve.motor.subscribe(
						eventType,
						(event) => void dispatchMotorAction(event, action, nerve, cache, log, motorInputSchemas[eventType]),
					),
				);
			}

			for (const [eventType, action] of Object.entries(actions.sense ?? {})) {
				unsubs.push(
					nerve.sense.subscribe(eventType, (event) => dispatchSenseAction(eventType, event, nerve, action, log)),
				);
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
