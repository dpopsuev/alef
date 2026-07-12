export type { ImageContent, TextContent, TextSignatureV1 } from "@dpopsuev/alef-kernel/content";

/**
 *
 */
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

/**
 *
 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}
