import type { ZodTypeAny, z } from "zod";
import type { Budget } from "../bus/budget.js";
import type { Bus, BusMiddleware } from "../bus/messages.js";
import type { ToolDefinition } from "./interface.js";

/** Structured logger interface expected by adapters for debug, info, warn, and error output. */
export interface AdapterLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	info(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
	child(bindings: Record<string, unknown>): AdapterLogger;
}

/** Context passed to a command action handler with correlation, tool call ID, and typed payload. */
export interface CommandHandlerCtx<TPayload = Record<string, unknown>> {
	readonly correlationId: string;
	readonly toolCallId: string | undefined;
	readonly payload: TPayload;
	readonly log: AdapterLogger;
}

/** An async-iterable handler for a bus command, with optional caching and invalidation hooks. */
export interface CommandAction {
	readonly tool?: ToolDefinition;
	handle(ctx: CommandHandlerCtx): AsyncIterable<Record<string, unknown>>;
	shouldCache?(ctx: CommandHandlerCtx, result: Record<string, unknown>): boolean;
	invalidates?(ctx: CommandHandlerCtx): string[];
}

/** Wrap a typed single-result handler into a CommandAction with schema-aware payload. */
export function typedAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	handle: (ctx: CommandHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	opts?: {
		shouldCache?: (ctx: CommandHandlerCtx<z.infer<TSchema>>, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: CommandHandlerCtx<z.infer<TSchema>>) => string[];
	},
): CommandAction {
	return {
		tool,
		async *handle(ctx) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic type erasure: TSchema ctx → base CommandHandlerCtx
			yield await (handle as (ctx: CommandHandlerCtx) => Promise<Record<string, unknown>>)(ctx);
		},
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic type erasure: TSchema → base CommandAction callbacks
		...(opts?.shouldCache && { shouldCache: opts.shouldCache as CommandAction["shouldCache"] }),
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic type erasure: TSchema → base CommandAction callbacks
		...(opts?.invalidates && { invalidates: opts.invalidates as CommandAction["invalidates"] }),
	};
}

/** Wrap a typed async-iterable stream into a streaming CommandAction. */
export function typedStreamAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	stream: (ctx: CommandHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
): CommandAction {
	return {
		tool: { ...tool, streaming: true },
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic type erasure: TSchema stream → base CommandAction handle
		handle: stream as CommandAction["handle"],
	};
}

/** Context passed to an event action handler with correlation, payload, and bus reference. */
export interface EventHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	readonly bus: Bus;
}

/** An async handler invoked when a subscribed event fires on the bus. */
export interface EventAction {
	handle(ctx: EventHandlerCtx): Promise<void>;
}

/** Map of event-type strings to their command action handlers. */
export type CommandActionMap = Record<string, CommandAction>;
/** Map of event-type strings to their event action handlers. */
export type EventActionMap = Record<string, EventAction>;

/** Maps each bus channel name to its corresponding action type. */
export interface ChannelActionTypes {
	command: CommandAction;
	event: EventAction;
	notification: EventAction;
}

/** Per-channel map of event types to their action handlers, used by defineAdapter. */
export type ActionMap = { [K in ChannelName]?: Record<string, ChannelActionTypes[K]> };

import type { AdapterContributions, SkillBook } from "./contributions.js";
import type { ChannelMap, ChannelName } from "../bus/messages.js";

/** Full configuration bag for defineAdapter including contributions, limits, and lifecycle hooks. */
export interface AdapterOptions {
	logger?: AdapterLogger;
	actions?: readonly string[];
	directives?: readonly string[];
	skills?: readonly SkillBook[];
	contributions?: AdapterContributions;
	description?: string;
	labels?: readonly string[];
	publishSchemas?: Partial<ChannelMap<Record<string, ZodTypeAny>>>;
	inputSchemas?: Partial<ChannelMap<Record<string, ZodTypeAny>>>;
	sources?: readonly { name: string; kind: "file" | "memory" | "process" }[];
	ready?: () => Promise<void>;
	onMount?: (bus: Bus) => void;
	onUnmount?: () => void;
	limits?: Budget;
	middlewares?: BusMiddleware[];
}
