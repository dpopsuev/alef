import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";

const TEXT_INPUT = "dialog.message";
const TEXT_MESSAGE = "dialog.message";

export class TextMessageOrgan implements Organ {
	readonly name = "text-message";

	readonly tools: readonly ToolDefinition[] = [
		{
			name: "dialog.message",
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
		// Motor/"dialog.message" → Sense/"dialog.message"
		// Corpus delivered a user message. Forward to LLMOrgan as a prompt.
		const offInput = nerve.motor.subscribe(TEXT_INPUT, (event) => {
			nerve.sense.publish({
				type: TEXT_INPUT,
				payload: {
					messages: [{ role: "user", content: event.payload.text }],
					tools: event.payload.tools,
				},
				correlationId: event.correlationId,
				timestamp: Date.now(),
				isError: false,
			});
		});

		// Motor/"dialog.message" → Sense/"dialog.message"
		// LLMOrgan sent its text reply. Forward back to Corpus.
		const offMessage = nerve.motor.subscribe(TEXT_MESSAGE, (event) => {
			nerve.sense.publish({
				type: TEXT_MESSAGE,
				payload: { text: event.payload.text },
				correlationId: event.correlationId,
				timestamp: Date.now(),
				isError: false,
			});
		});

		return () => {
			offInput();
			offMessage();
		};
	}
}
