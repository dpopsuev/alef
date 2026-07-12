import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";

/**
 *
 */
export interface SubagentFactoryOptions {
	adapters: readonly Adapter[];
	onChunk?: (chunk: string) => void;
	onInnerEvent?: (callId: string, type: string, payload: Record<string, unknown>) => void;
	systemPrompt?: string;
	/** Soft token budget. When exceeded, a "wrap up" message is injected instead of hard-aborting. */
	tokenBudget?: number;
	/** Override the model for this subagent (e.g. 'claude-haiku-4-5' for cheap exploration). */
	modelOverride?: string;
}

/**
 *
 */
export interface SubagentSession {
	send?(content: string | (TextContent | ImageContent)[], timeoutMs?: number): Promise<string>;
	dispose(): void | Promise<void>;
}

/**
 *
 */
export type SubagentFactory = (opts: SubagentFactoryOptions) => SubagentSession;
