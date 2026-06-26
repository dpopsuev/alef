import type { ZodTypeAny, z } from "zod";
import type { Budget } from "../bus/budget.js";
import type { Bus, BusMiddleware } from "../bus/messages.js";
import type { ToolDefinition } from "./interface.js";

export interface AdapterLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	info(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
	child(bindings: Record<string, unknown>): AdapterLogger;
}

export interface CommandHandlerCtx<TPayload = Record<string, unknown>> {
	readonly correlationId: string;
	readonly toolCallId: string | undefined;
	readonly payload: TPayload;
	readonly log: AdapterLogger;
}

export interface CommandAction {
	readonly tool?: ToolDefinition;
	handle(ctx: CommandHandlerCtx): AsyncIterable<Record<string, unknown>>;
	shouldCache?(ctx: CommandHandlerCtx, result: Record<string, unknown>): boolean;
	invalidates?(ctx: CommandHandlerCtx): string[];
}

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

export interface EventHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	readonly bus: Bus;
}

export interface EventAction {
	handle(ctx: EventHandlerCtx): Promise<void>;
}

export type CommandActionMap = Record<string, CommandAction>;
export type EventActionMap = Record<string, EventAction>;

export interface ChannelActionTypes {
	command: CommandAction;
	event: EventAction;
	notification: EventAction;
}

export type ActionMap = { [K in ChannelName]?: Record<string, ChannelActionTypes[K]> };

import type { AdapterContributions, SkillBook } from "./contributions.js";
import type { ChannelMap, ChannelName } from "../bus/messages.js";

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
