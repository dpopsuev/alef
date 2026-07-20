import type { TSchema } from "typebox";

/** Native text result returned by a tool adapter. */
export interface NativeToolResult {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details?: Record<string, unknown>;
}
/** Minimal public tool registration shape used by the adapter. */
export interface NativeToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	execute(callId: string, params: Record<string, unknown>): Promise<NativeToolResult>;
}
/** Public extension surface required by this adapter. */
export interface NativeExtensionApi {
	registerTool(tool: NativeToolDefinition): void;
	on(
		event: "before_agent_start",
		handler: (input: { readonly systemPrompt?: string }) => Promise<{ readonly systemPrompt: string } | undefined>,
	): void;
}
