import type { ZodTypeAny, z } from "zod";
import type { ToolDefinition } from "./buses.js";
import type { CorpusAction, CorpusHandlerCtx, OrganLogger, OrganOptions, StreamingCorpusAction } from "./framework.js";
import { typedAction, typedStreamAction } from "./framework.js";
import { type SenseDisplayBlock, withDisplay } from "./payload.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

export interface BaseOrganOptions {
	cwd?: string;
	actions?: readonly string[];
	logger?: OrganLogger;
}

export interface TimeoutOrganOptions extends BaseOrganOptions {
	defaultTimeoutSeconds?: number;
	maxTimeoutSeconds?: number;
}

export function resolveTimeout(
	opts: Pick<TimeoutOrganOptions, "defaultTimeoutSeconds" | "maxTimeoutSeconds">,
	requested: number | undefined,
	defaults: { default: number; max: number },
): number {
	const effective = requested ?? opts.defaultTimeoutSeconds ?? defaults.default;
	return Math.min(effective, opts.maxTimeoutSeconds ?? defaults.max) * 1000;
}

export function spreadOrganOptions<T extends BaseOrganOptions>(opts: T): Pick<OrganOptions, "actions" | "logger"> {
	return { actions: opts.actions, logger: opts.logger };
}

export interface OrganTool<TSchema extends ZodTypeAny> extends ToolDefinition {
	readonly inputSchema: TSchema;
	action(
		handle: (ctx: CorpusHandlerCtx<z.infer<TSchema>>) => Promise<Record<string, unknown>>,
	): Record<string, CorpusAction>;
	stream(
		generate: (ctx: CorpusHandlerCtx<z.infer<TSchema>>) => AsyncIterable<Record<string, unknown>>,
	): Record<string, StreamingCorpusAction>;
}

export function tool<TSchema extends ZodTypeAny>(
	name: string,
	description: string,
	schema: TSchema,
): OrganTool<TSchema> {
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
	action: CorpusAction,
	policy: {
		shouldCache?: (ctx: CorpusHandlerCtx, result: Record<string, unknown>) => boolean;
		invalidates?: (ctx: CorpusHandlerCtx) => string[];
	},
): CorpusAction {
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
