import { type Api, type AssistantMessage, type Message, type Model, streamSimple, type Tool } from "@dpopsuev/alef-ai";
import type { CerebrumNerve, CerebrumOrgan, ToolDefinition } from "@dpopsuev/alef-spine";

const TEXT_INPUT = "text.input";
const TEXT_MESSAGE = "text.message";

export interface LLMOrganOptions {
	model: Model<Api>;
	apiKey?: string;
	timeoutMs?: number;
	maxRetries?: number;
}

export class LLMOrgan implements CerebrumOrgan {
	readonly kind = "cerebrum" as const;
	readonly name = "llm";
	readonly tools = [] as const;

	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	constructor(private readonly options: LLMOrganOptions) {
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.maxRetries = options.maxRetries ?? 3;
	}

	mount(nerve: CerebrumNerve): () => void {
		// Subscribe Sense/"text.input" — TextMessageOrgan sent a prompt.
		return nerve.sense.subscribe(TEXT_INPUT, (event) => {
			const payload = event.payload as { messages: readonly unknown[]; tools: readonly ToolDefinition[] };
			void this.handlePrompt(nerve, payload, event.correlationId);
		});
	}

	private async handlePrompt(
		nerve: CerebrumNerve,
		payload: {
			messages: readonly unknown[];
			tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
		},
		correlationId: string,
	): Promise<void> {
		const tools: Tool[] = payload.tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.inputSchema,
		}));

		const messages: Message[] = (payload.messages as Message[]).map((m) => {
			if ("timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number") return m;
			return { ...(m as object), timestamp: Date.now() } as Message;
		});

		// Turn loop: call LLM → fan-out all tool calls in parallel → repeat.
		// Termination = quiescence: LLM produced zero tool calls in a turn.
		// text.message is a regular tool call — not a termination signal.
		while (true) {
			const stream = streamSimple(
				this.options.model,
				{ messages, tools },
				{ apiKey: this.options.apiKey, timeoutMs: this.timeoutMs, maxRetries: this.maxRetries },
			);

			let finalMessage: AssistantMessage | undefined;
			const pendingCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];

			for await (const evt of stream) {
				if (evt.type === "toolcall_end") {
					pendingCalls.push({
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
			messages.push(finalMessage);

			// Quiescence: no tool calls this turn — also emit any inline text.
			if (pendingCalls.length === 0) {
				const text = extractText(finalMessage);
				if (text) {
					nerve.motor.publish({
						type: TEXT_MESSAGE,
						payload: { text },
						correlationId,
						timestamp: Date.now(),
					});
				}
				break;
			}

			// Fan-out: publish ALL Motor events simultaneously, await ALL Sense results.
			const results = await Promise.all(
				pendingCalls.map((tc) => {
					nerve.motor.publish({
						type: tc.name,
						payload: { ...tc.args, toolCallId: tc.id },
						correlationId,
						timestamp: Date.now(),
					});
					return this.waitForToolResult(nerve, tc.name, tc.id, correlationId);
				}),
			);

			// Feed all results back to LLM in original call order.
			for (let i = 0; i < pendingCalls.length; i++) {
				const tc = pendingCalls[i];
				const result = results[i];
				messages.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: payloadToText(result.payload, result.isError, result.errorMessage) }],
					isError: result.isError,
					timestamp: Date.now(),
				});
			}
		}
	}

	private waitForToolResult(
		nerve: CerebrumNerve,
		toolName: string,
		toolCallId: string,
		correlationId: string,
	): Promise<import("@dpopsuev/alef-spine").SenseEvent> {
		return new Promise((resolve) => {
			const off = nerve.sense.subscribe(toolName, (event) => {
				if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
					off();
					resolve(event);
				}
			});
		});
	}
}

/** Render a Sense payload as text for the LLM tool result. */
function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	// Common fields from organ responses
	if (typeof payload.content === "string") return payload.content;
	if (typeof payload.text === "string") return payload.text;
	// Structured payloads (fs.find, fs.grep, web.search, etc.) — serialize
	const { toolCallId: _id, ...rest } = payload;
	return JSON.stringify(rest);
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}
