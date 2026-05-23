import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@dpopsuev/alef-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that triggered the tool call. */
	assistantMessage: AssistantMessage;
	/** The tool call to be executed. */
	toolCall: AgentToolCall;
	/** Validated arguments from the tool call. */
	args: unknown;
	/** Current agent context. */
	context: AgentContext;
}

/**
 * Result returned from `afterToolCall`.
 *
 * Allows modifying or replacing a tool's result before it becomes a ToolResultMessage artifact.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	terminate?: boolean;
	isError?: boolean;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that triggered the tool call. */
	assistantMessage: AssistantMessage;
	/** The tool call that was executed. */
	toolCall: AgentToolCall;
	/** Validated arguments passed to the tool. */
	args: unknown;
	/** The result returned by the tool. */
	result: AgentToolResult<unknown>;
	/** Whether the tool failed. */
	isError: boolean;
	/** Current agent context. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<unknown>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages when the agent would otherwise stop.
	 *
	 * Called when `shouldStopAfterTurn` doesn't request an exit, tool calls finish,
	 * and `getSteeringMessages` returns []. If messages are returned, the loop starts
	 * another turn. If [] is returned, the loop emits `agent_end` and exits.
	 *
	 * Use this to queue planned work after the main prompt finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Hook called before each tool call is executed.
	 *
	 * Useful for logging or blocking specific tool calls.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Hook called after each tool call completes.
	 *
	 * Allows modifying tool results before they're passed to the LLM.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

	/** Tool execution mode for batches. */
	toolExecution?: ToolExecutionMode;
}

/**
 * User message with text and optional images.
 */
export interface UserMessage {
	role: "user";
	content: (TextContent | ImageContent)[];
	timestamp: number;
}

/**
 * User message that includes file attachments.
 */
export interface UserWithAttachmentsMessage {
	role: "user-with-attachments";
	content: (TextContent | ImageContent)[];
	attachments: Array<{ name: string; mimeType: string; data: string }>;
	timestamp: number;
}

/**
 * Artifact message - persisted but not sent to the LLM.
 * Used for storing session data.
 */
export interface ArtifactMessage {
	role: "artifact";
	artifactType: string;
	content: (TextContent | ImageContent)[];
	timestamp: number;
}

/**
 * Union of all supported agent message types.
 */
export type AgentMessage =
	| UserMessage
	| UserWithAttachmentsMessage
	| AssistantMessage
	| ToolResultMessage
	| ArtifactMessage;

/** Context passed to the agent loop. */
export interface AgentContext {
	/** System prompt. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<TSchema>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
	  };

/**
 * Agent state exposed via the `Agent.state` getter.
 */
export interface AgentState {
	/** System prompt used for all turns. */
	systemPrompt: string;
	/** Model configuration. */
	model: Model<unknown>;
	/** Thinking level preference. */
	thinkingLevel: "off" | "low" | "medium" | "high";
	/** Tools available to the agent. */
	tools: AgentTool<TSchema>[];
	/** Complete message history including user, assistant, and tool result messages. */
	messages: AgentMessage[];
	/** True if actively streaming an assistant response. */
	readonly isStreaming: boolean;
	/** Partial assistant message being streamed, if any. */
	readonly streamingMessage?: AgentMessage;
	/** IDs of tool calls currently being executed. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** High-level capability kind for runtime actions. */
export type AgentCapabilityKind = "tool" | "memory" | "session" | "model" | "supervisor";

/** Where a capability can be exposed in the runtime hierarchy. */
export type AgentCapabilityAvailability = "root" | "child" | "shared";

/**
 * Metadata for a runtime action.
 *
 * Alef still executes LLM-triggered work as tools, but this metadata lets higher
 * layers treat tool, memory, and supervisor operations as one action model.
 */
export interface AgentActionMetadata {
	kind: AgentCapabilityKind;
	capability?: string;
	availability?: AgentCapabilityAvailability;
	description?: string;
}

/** General action definition used by platform runtimes built on top of the agent loop. */
export interface AgentActionDefinition<TParameters extends TSchema = TSchema, TDetails = unknown>
	extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/** Action metadata for capability-aware runtimes. */
	action: AgentActionMetadata;
	/**
	 * Optional compatibility shim for raw action arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (rawArgs: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Execute the action.
	 *
	 * @param toolCallId - Unique identifier for this call instance.
	 * @param args - Validated arguments matching TParameters.
	 * @param signal - Abort signal for cancellation.
	 * @param update - Callback for streaming partial results.
	 * @returns Final result with content and optional structured details.
	 */
	execute: (
		toolCallId: string,
		args: Static<TParameters>,
		signal?: AbortSignal,
		update?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Sequential execution mode hint.
	 * When true, this tool always runs sequentially even when toolExecution is "parallel".
	 */
	executionMode?: "sequential" | "parallel";
}

/** Simpler tool definition for tools that don't need the full action metadata. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
	/** Tool label for UI display. */
	label?: string;
	/** Tool name exposed to the LLM. */
	name: string;
	/** Tool description shown to the LLM. */
	description: string;
	/** TypeBox schema for tool parameters. */
	parameters: TParameters;
	/**
	 * Optional compatibility shim for raw action arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (rawArgs: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Execute the tool.
	 *
	 * @param toolCallId - Unique identifier for this call instance.
	 * @param args - Validated arguments matching TParameters.
	 * @param signal - Abort signal for cancellation.
	 * @param update - Callback for streaming partial results.
	 * @returns Final result with content and optional structured details.
	 */
	execute: (
		toolCallId: string,
		args: Static<TParameters>,
		signal?: AbortSignal,
		update?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Sequential execution mode hint.
	 * When true, this tool always runs sequentially even when toolExecution is "parallel".
	 */
	executionMode?: "sequential" | "parallel";
}
