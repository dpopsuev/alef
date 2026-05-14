import { type Api, type AssistantMessage, type Message, type Model, streamSimple, type Tool } from "@dpopsuev/alef-ai";
import type { CerebrumNerve, CerebrumOrgan, ToolDefinition } from "@dpopsuev/alef-spine";

// LLM organ event type constants
const SENSE_LLM_PROMPT = "llm.prompt";
const MOTOR_TEXT_MESSAGE = "text.message";
const MOTOR_LLM_TOOL_CALL = "llm.tool_call";
const SENSE_LLM_TOOL_RESULT = "llm.tool_result";

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
		// Subscribe Sense/"llm.prompt" — TextMessageOrgan sent a prompt.
		return nerve.sense.subscribe(SENSE_LLM_PROMPT, (event) => {
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

		// Turn loop: call LLM → process tool calls → repeat until text.message fires.
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

			// Text response — synthesize a text.message tool call.
			if (pendingCalls.length === 0) {
				const text = extractText(finalMessage);
				if (text) {
					nerve.motor.publish({
						type: MOTOR_TEXT_MESSAGE,
						payload: { text },
						correlationId,
						timestamp: Date.now(),
					});
				}
				break;
			}

			// Tool calls — emit each as Motor/"llm.tool_call".
			let sentTextMessage = false;
			for (const tc of pendingCalls) {
				if (tc.name === "text.message") {
					// Terminal: text reply via tool call.
					nerve.motor.publish({
						type: MOTOR_TEXT_MESSAGE,
						payload: { text: typeof tc.args.text === "string" ? tc.args.text : "" },
						correlationId,
						timestamp: Date.now(),
					});
					sentTextMessage = true;
					break;
				}

				// Non-terminal tool — emit and wait for result.
				nerve.motor.publish({
					type: MOTOR_LLM_TOOL_CALL,
					payload: { toolName: tc.name, toolCallId: tc.id, args: tc.args },
					correlationId,
					timestamp: Date.now(),
				});

				const result = await this.waitForToolResult(nerve, tc.id, correlationId);
				messages.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: String(result.payload.result) }],
					isError: result.payload.isError === true,
					timestamp: Date.now(),
				});
			}

			if (sentTextMessage) break;
		}
	}

	private waitForToolResult(
		nerve: CerebrumNerve,
		toolCallId: string,
		correlationId: string,
	): Promise<{ payload: Record<string, unknown> }> {
		return new Promise((resolve) => {
			const off = nerve.sense.subscribe(SENSE_LLM_TOOL_RESULT, (event) => {
				if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
					off();
					resolve(event);
				}
			});
		});
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}
