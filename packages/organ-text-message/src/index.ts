import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// TextMessageOrgan — text I/O boundary organ.
//
// Subscribes to:
//   Sense/user_message  — user sends text in
//   Motor/tool_call("send_message") — LLM replies via its send_message tool
//
// Emits:
//   Motor/llm_request   — triggers the LLMOrgan with messages + tools
//   Motor/user_reply    — delivers the LLM's reply back to Corpus
//
// Exposes:
//   send_message tool   — the only way the LLM can reply to the user
//
// Note: no message history. History belongs in a future STM organ.
// TextMessageOrgan is stateless — one user_message → one llm_request.
// ---------------------------------------------------------------------------

export class TextMessageOrgan implements Organ {
	readonly name = "text-message";

	readonly tools: readonly ToolDefinition[] = [
		{
			name: "send_message",
			description: "Send a text reply to the user.",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", description: "The reply text." },
				},
				required: ["text"],
				additionalProperties: false,
			},
		},
	];

	mount(nerve: Nerve): () => void {
		// Sense/user_message → Motor/llm_request
		const offUserMessage = nerve.sense.on("user_message", (event) => {
			if (event.type !== "user_message") return;
			nerve.motor.emit({
				type: "llm_request",
				messages: [{ role: "user", content: event.text }],
				tools: event.tools,
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});

		// Motor/tool_call("send_message") → Motor/user_reply
		const offToolCall = nerve.motor.on("tool_call", (event) => {
			if (event.type !== "tool_call" || event.toolName !== "send_message") return;
			const text = typeof event.args.text === "string" ? event.args.text : "";
			nerve.motor.emit({
				type: "user_reply",
				text,
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});

		return () => {
			offUserMessage();
			offToolCall();
		};
	}
}
