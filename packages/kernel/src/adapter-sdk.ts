import type { ZodTypeAny, z } from "zod";
import type { ToolDefinition } from "./buses.js";
import type { AdapterLogger, AdapterOptions, MotorAction, MotorHandlerCtx } from "./framework.js";
import { typedAction, typedStreamAction } from "./framework.js";
import { type SenseDisplayBlock, withDisplay } from "./payload.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

export interface BaseAdapterOptions {
	cwd?: string;
	actions?: readonly string[];
	logger?: AdapterLogger;
}
/** @deprecated Use BaseAdapterOptions */
export type BaseOrganOptions = BaseAdapterOptions;

export interface TimeoutAdapterOptions extends BaseAdapterOptions {
	defaultTimeoutSeconds?: number;
	maxTimeoutSeconds?: number;
}

/** @deprecated Use TimeoutAdapterOptions */
export type TimeoutOrganOptions = TimeoutAdapterOptions;

export function resolveTimeout(
	opts: Pick<TimeoutAdapterOptions, "defaultTimeoutSeconds" | "maxTimeoutSeconds">,
	requested: number | undefined,
	defaults: { default: number; max: number },
): number {
	const effective = requested ?? opts.defaultTimeoutSeconds ?? defaults.default;
	return Math.min(effective, opts.maxTimeoutSeconds ?? defaults.max) * 1000;
}

export function spreadAdapterOptions<T extends BaseAdapterOptions>(
	opts: T,
): Pick<AdapterOptions, "actions" | "logger"> {
	return { actions: opts.actions, logger: opts.logger };
}
/** @deprecated Use spreadAdapterOptions */
export const spreadOrganOptions = spreadAdapterOptions;

export interface AdapterTool<TSchema extends ZodTypeAny> extends ToolDefinition {
	readonly inputSchema: TSchema;
	action(
		handle: (ctx: MotorHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	): Record<string, MotorAction>;
	stream(
		generate: (ctx: MotorHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
	): Record<string, MotorAction>;
}
/** @deprecated Use AdapterTool */
export type OrganTool<TSchema extends ZodTypeAny> = AdapterTool<TSchema>;

export function tool<TSchema extends ZodTypeAny>(
	name: string,
	description: string,
	schema: TSchema,
): AdapterTool<TSchema> {
	const definition: ToolDefinition & { inputSchema: TSchema } = { name, description, inputSchema: schema };
	return {
		...definition,
		action(handle) {
			return { [`motor/${name}`]: typedAction(definition, handle) };
		},
		stream(generate) {
			return { [`motor/${name}`]: typedStreamAction(definition, generate) };
		},
	};
}

export function directive(...lines: string[]): string[] {
	return lines;
}

export function cachePolicy(
	action: MotorAction,
	policy: {
		shouldCache?: (ctx: MotorHandlerCtx, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: MotorHandlerCtx) => string[];
	},
): MotorAction {
	return { ...action, ...policy };
}

export function withTruncatedDisplay(
	data: Record<string, unknown>,
	content: string,
	opts?: { maxLines?: number; maxBytes?: number; mimeType?: SenseDisplayBlock["mimeType"] },
): Record<string, unknown> {
	const tr = truncateHead(content, {
		maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
	});
	return withDisplay(
		{ ...data, content: tr.content, truncated: tr.truncated },
		{
			text: tr.content,
			mimeType: opts?.mimeType ?? "text/plain",
		},
	);
}
