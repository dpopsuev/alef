import type { ZodTypeAny, z } from "zod";
import type { Budget } from "./budget.js";
import type { Nerve, NerveMiddleware, ToolDefinition } from "./buses.js";

export interface AdapterLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	info(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
	child(bindings: Record<string, unknown>): AdapterLogger;
}

/** @deprecated Use AdapterLogger */
export type OrganLogger = AdapterLogger;

export interface MotorHandlerCtx<TPayload = Record<string, unknown>> {
	readonly correlationId: string;
	readonly toolCallId: string | undefined;
	readonly payload: TPayload;
	readonly log: AdapterLogger;
}

export interface MotorAction {
	readonly tool?: ToolDefinition;
	handle(ctx: MotorHandlerCtx): AsyncIterable<Record<string, unknown>>;
	shouldCache?(ctx: MotorHandlerCtx, result: Record<string, unknown>): boolean;
	invalidates?(ctx: MotorHandlerCtx): string[];
}

export function typedAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	handle: (ctx: MotorHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	opts?: {
		shouldCache?: (ctx: MotorHandlerCtx<z.infer<TSchema>>, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: MotorHandlerCtx<z.infer<TSchema>>) => string[];
	},
): MotorAction {
	return {
		tool,
		async *handle(ctx) {
			yield await (handle as (ctx: MotorHandlerCtx) => Promise<Record<string, unknown>>)(ctx);
		},
		...(opts?.shouldCache && { shouldCache: opts.shouldCache as MotorAction["shouldCache"] }),
		...(opts?.invalidates && { invalidates: opts.invalidates as MotorAction["invalidates"] }),
	};
}

export function typedStreamAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	stream: (ctx: MotorHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
): MotorAction {
	return {
		tool: { ...tool, streaming: true },
		handle: stream as MotorAction["handle"],
	};
}

export interface SenseHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	readonly motor: Nerve["motor"];
	readonly sense: Nerve["sense"];
	readonly signal: Nerve["signal"];
}

export interface SenseAction {
	handle(ctx: SenseHandlerCtx): Promise<void>;
}

export type MotorActionMap = Record<string, MotorAction>;
export type SenseActionMap = Record<string, SenseAction>;
export interface ActionMap {
	motor?: MotorActionMap;
	sense?: SenseActionMap;
}

import type { AdapterContributions, SkillBook } from "./buses.js";

export interface AdapterOptions {
	logger?: AdapterLogger;
	actions?: readonly string[];
	directives?: readonly string[];
	skills?: readonly SkillBook[];
	contributions?: AdapterContributions;
	description?: string;
	labels?: readonly string[];
	publishSchemas?: {
		motor?: Record<string, ZodTypeAny>;
		sense?: Record<string, ZodTypeAny>;
	};
	inputSchemas?: {
		motor?: Record<string, ZodTypeAny>;
	};
	sources?: readonly { name: string; kind: "file" | "memory" | "process" }[];
	ready?: () => Promise<void>;
	onMount?: (nerve: Nerve) => void;
	onUnmount?: () => void;
	limits?: Budget;
	middlewares?: NerveMiddleware[];
}

/** @deprecated Use AdapterOptions */
export type OrganOptions = AdapterOptions;
