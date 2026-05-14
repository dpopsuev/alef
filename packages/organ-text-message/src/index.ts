import type { CorpusNerve, CorpusOrgan, ToolDefinition } from "@dpopsuev/alef-spine";

const TEXT_INPUT = "text.input";
const TEXT_MESSAGE = "text.message";

export class TextMessageOrgan implements CorpusOrgan {
	readonly kind = "corpus" as const;
	readonly name = "text-message";

	readonly tools: readonly ToolDefinition[] = [
		{
			name: "text.message",
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

	mount(nerve: CorpusNerve): () => void {
		// Motor/"text.input" → Sense/"text.input"
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

		// Motor/"text.message" → Sense/"text.message"
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
