import type { ZodTypeAny, z } from "zod";
import type { Budget } from "./budget.js";
import type { Nerve, NerveMiddleware, ToolDefinition } from "./buses.js";

export interface OrganLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CorpusHandlerCtx<TPayload = Record<string, unknown>> {
	readonly correlationId: string;
	readonly toolCallId: string | undefined;
	readonly payload: TPayload;
	/** Child logger pre-stamped with organ and tool name. Use for warn/debug from handler code. */
	readonly log: OrganLogger;
}

export interface CorpusAction {
	readonly tool?: ToolDefinition;
	handle(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>>;
	shouldCache?(ctx: CorpusHandlerCtx, result: Record<string, unknown>): boolean;
	invalidates?(ctx: CorpusHandlerCtx): string[];
}

export function typedAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	handle: (ctx: CorpusHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	opts?: {
		shouldCache?: (ctx: CorpusHandlerCtx<z.infer<TSchema>>, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: CorpusHandlerCtx<z.infer<TSchema>>) => string[];
	},
): CorpusAction {
	return {
		tool,
		handle: handle as CorpusAction["handle"],
		...(opts?.shouldCache && { shouldCache: opts.shouldCache as CorpusAction["shouldCache"] }),
		...(opts?.invalidates && { invalidates: opts.invalidates as CorpusAction["invalidates"] }),
	};
}

export function typedStreamAction<TSchema extends ZodTypeAny>(
	tool: ToolDefinition & { readonly inputSchema: TSchema },
	stream: (ctx: CorpusHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
): StreamingCorpusAction {
	// Mark the tool as streaming so organComplianceSuite can auto-discover it.
	return { tool: { ...tool, streaming: true }, stream: stream as StreamingCorpusAction["stream"] };
}

export interface StreamingCorpusAction {
	readonly tool?: ToolDefinition;
	stream(ctx: CorpusHandlerCtx): AsyncIterable<Record<string, unknown>>;
}

export interface CerebrumHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	readonly motor: Nerve["motor"];
	readonly sense: Nerve["sense"];
}

export interface CerebrumAction {
	handle(ctx: CerebrumHandlerCtx): Promise<void>;
}

export type CorpusActionMap = Record<string, CorpusAction | StreamingCorpusAction>;
export type CerebrumActionMap = Record<string, CerebrumAction>;
export type ActionMap = Record<string, CorpusAction | StreamingCorpusAction | CerebrumAction>;

export interface OrganOptions {
	logger?: OrganLogger;
	actions?: readonly string[];
	directives?: readonly string[];
	description?: string;
	labels?: readonly string[];
	publishSchemas?: {
		motor?: Record<string, ZodTypeAny>;
		sense?: Record<string, ZodTypeAny>;
	};
	inputSchemas?: {
		motor?: Record<string, ZodTypeAny>;
	};
	ready?: () => Promise<void>;
	onUnmount?: () => void;
	limits?: Budget;
	middlewares?: NerveMiddleware[];
}
