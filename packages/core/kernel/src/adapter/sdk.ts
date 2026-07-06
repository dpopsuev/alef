import type { ZodTypeAny, z } from "zod";
import type { ToolDefinition } from "./interface.js";
import type { AdapterLogger, AdapterOptions, CommandAction, CommandHandlerCtx } from "./framework.js";
import { typedAction, typedStreamAction } from "./framework.js";
import { type SenseDisplayBlock, withDisplay } from "../payload.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

/** Minimal options shared by all adapter constructors. */
export interface BaseAdapterOptions {
	cwd?: string;
	actions?: readonly string[];
	logger?: AdapterLogger;
}

/** Adapter options extended with configurable default and maximum timeout. */
export interface TimeoutAdapterOptions extends BaseAdapterOptions {
	defaultTimeoutSeconds?: number;
	maxTimeoutSeconds?: number;
}

/** Resolve an effective timeout in milliseconds, clamped to a configured maximum. */
export function resolveTimeout(
	opts: Pick<TimeoutAdapterOptions, "defaultTimeoutSeconds" | "maxTimeoutSeconds">,
	requested: number | undefined,
	defaults: { default: number; max: number },
): number {
	const effective = requested ?? opts.defaultTimeoutSeconds ?? defaults.default;
	// eslint-disable-next-line no-magic-numbers
	return Math.min(effective, opts.maxTimeoutSeconds ?? defaults.max) * 1000;
}

/** Extract the subset of BaseAdapterOptions needed by defineAdapter. */
export function spreadAdapterOptions<T extends BaseAdapterOptions>(
	opts: T,
): Pick<AdapterOptions, "actions" | "logger"> {
	return { actions: opts.actions, logger: opts.logger };
}

/** Type-safe tool builder that pairs a ToolDefinition with action/stream wiring. */
export interface AdapterTool<TSchema extends ZodTypeAny> extends ToolDefinition {
	readonly inputSchema: TSchema;
	action(
		handle: (ctx: CommandHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	): Record<string, CommandAction>;
	stream(
		generate: (ctx: CommandHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
	): Record<string, CommandAction>;
}

/** Create a typed tool definition with fluent .action() and .stream() helpers. */
export function tool<TSchema extends ZodTypeAny>(
	name: string,
	description: string,
	schema: TSchema,
): AdapterTool<TSchema> {
	const definition: ToolDefinition & { inputSchema: TSchema } = { name, description, inputSchema: schema };
	return {
		...definition,
		action(handle) {
			return { [`command/${name}`]: typedAction(definition, handle) };
		},
		stream(generate) {
			return { [`command/${name}`]: typedStreamAction(definition, generate) };
		},
	};
}

/** Tag an array of strings as adapter directive lines (identity helper for readability). */
export function directive(...lines: string[]): string[] {
	return lines;
}

/** Attach caching and invalidation behaviour to a command action. */
export function cachePolicy(
	action: CommandAction,
	policy: {
		shouldCache?: (ctx: CommandHandlerCtx, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: CommandHandlerCtx) => string[];
	},
): CommandAction {
	return { ...action, ...policy };
}

/** Truncate content and attach a TUI display block to the event payload. */
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
