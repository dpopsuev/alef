import { type Api, type AssistantMessage, type Message, type Model, streamSimple, type Tool } from "@dpopsuev/alef-ai";
import type { LLMRequestEvent, Nerve, Organ, ToolResultEvent } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// LLMOrganOptions
// ---------------------------------------------------------------------------

export interface LLMOrganOptions {
	model: Model<Api>;
	/**
	 * API key passed to the provider. When omitted, the provider reads from
	 * its default environment variable (e.g. ANTHROPIC_API_KEY).
	 */
	apiKey?: string;
	/** Timeout per LLM call in ms. Default: 60_000. */
	timeoutMs?: number;
	/** Max retries per LLM call. Default: 3. */
	maxRetries?: number;
	/**
	 * Name of the terminal tool — when the LLM calls this, the turn ends.
	 * Defaults to "send_message" (handled by TextMessageOrgan).
	 */
	terminalTool?: string;
}

// ---------------------------------------------------------------------------
// LLMOrgan
//
// Subscribes to Motor/llm_request. Runs a turn loop:
//   1. Call LLM via streamSimple with messages + tools.
//   2. On toolcall_end: emit Motor/tool_call(name, args, correlationId).
//   3. If the tool is the terminal tool (send_message): stop. TextMessageOrgan
//      handles it and emits Motor/user_reply back to Corpus.
//   4. For non-terminal tools: wait for Sense/tool_result, append to messages,
//      loop back to step 1.
//   5. On text response (LLM ignored tool_choice): synthesize a send_message
//      tool call so the turn still terminates cleanly.
// ---------------------------------------------------------------------------

export class LLMOrgan implements Organ {
	readonly name = "llm";

	/** LLMOrgan does not expose tools to itself — it IS the LLM. */
	readonly tools = [] as const;

	private readonly terminalTool: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	constructor(private readonly options: LLMOrganOptions) {
		this.terminalTool = options.terminalTool ?? "send_message";
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.maxRetries = options.maxRetries ?? 3;
	}

	mount(nerve: Nerve): () => void {
		return nerve.motor.on("llm_request", (event) => {
			if (event.type !== "llm_request") return;
			void this.handleRequest(nerve, event);
		});
	}

	private async handleRequest(nerve: Nerve, event: LLMRequestEvent): Promise<void> {
		const { correlationId } = event;
		const tools = toAiTools(event.tools);

		// Messages accumulate across tool-use turns.
		const messages: Message[] = (event.messages as Message[]).map((m) => {
			if ("timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number") return m;
			return { ...(m as object), timestamp: Date.now() } as Message;
		});

		// Turn loop: call LLM → process tool calls → repeat until terminal.
		while (true) {
			const stream = streamSimple(
				this.options.model,
				{ messages, tools },
				{
					apiKey: this.options.apiKey,
					timeoutMs: this.timeoutMs,
					maxRetries: this.maxRetries,
				},
			);

			let finalMessage: AssistantMessage | undefined;
			const pendingToolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];

			for await (const evt of stream) {
				if (evt.type === "toolcall_end") {
					pendingToolCalls.push({
						name: evt.toolCall.name,
						args: evt.toolCall.arguments as Record<string, unknown>,
						id: evt.toolCall.id,
					});
				} else if (evt.type === "done") {
					finalMessage = evt.message;
				} else if (evt.type === "error") {
					finalMessage = evt.error;
				}
			}

			if (!finalMessage) break;

			// Append the assistant turn to history.
			messages.push(finalMessage);

			// ── Text response (LLM chose not to use a tool) ───────────────
			if (pendingToolCalls.length === 0) {
				const text = extractText(finalMessage);
				if (text) {
					nerve.motor.emit({
						type: "tool_call",
						toolName: this.terminalTool,
						args: { text },
						correlationId,
						timestamp: Date.now(),
					});
				}
				break;
			}

			// ── Tool-use response ──────────────────────────────────────────
			let reachedTerminal = false;

			for (const tc of pendingToolCalls) {
				nerve.motor.emit({
					type: "tool_call",
					toolName: tc.name,
					args: tc.args,
					correlationId,
					timestamp: Date.now(),
				});

				if (tc.name === this.terminalTool) {
					reachedTerminal = true;
					break; // Terminal tool — TextMessageOrgan handles the rest.
				}

				// Non-terminal: wait for the organ that owns this tool to respond.
				const result = await this.waitForToolResult(nerve, tc.name, correlationId);

				messages.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: String(result.result) }],
					isError: result.isError,
					timestamp: Date.now(),
				});
			}

			if (reachedTerminal) break;
		}
	}

	/**
	 * Subscribe to Sense/tool_result and resolve when a result arrives for
	 * the given toolName in the current turn (matched by correlationId).
	 */
	private waitForToolResult(nerve: Nerve, toolName: string, correlationId: string): Promise<ToolResultEvent> {
		return new Promise((resolve) => {
			const off = nerve.sense.on("tool_result", (event) => {
				if (event.type === "tool_result" && event.toolName === toolName && event.correlationId === correlationId) {
					off();
					resolve(event);
				}
			});
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAiTools(tools: LLMRequestEvent["tools"]): Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.inputSchema,
	}));
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}
