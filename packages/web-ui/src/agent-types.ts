import type { AssistantMessageEvent, ImageContent, Message, Model, TextContent } from "@dpopsuev/alef-llm";
import type { Static, TSchema } from "typebox";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ToolExecutionMode = "sequential" | "parallel";

export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentToolResult<T = any> {
	content: (TextContent | ImageContent)[];
	details: T;
	terminate?: boolean;
}

export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
	name: string;
	label: string;
	description?: string;
	parameters?: TParameters;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	executionMode?: ToolExecutionMode;
}

export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: any[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

export interface Agent {
	state: AgentState;
	subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
	prompt(input: string | AgentMessage): Promise<void>;
	abort(): void;
	steer(message: AgentMessage): void;
	streamFn?: unknown;
	getApiKey?: (provider: string) => string | Promise<string | undefined> | undefined;
}
