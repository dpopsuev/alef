import type { CorpusNerve, CorpusOrgan, ToolDefinition } from "@dpopsuev/alef-spine";

// TextMessageOrgan event type constants
const MOTOR_TEXT_INPUT = "text.input";
const SENSE_LLM_PROMPT = "llm.prompt";
const MOTOR_TEXT_MESSAGE = "text.message";
const SENSE_TEXT_REPLY = "text.reply";

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
		// Motor/"text.input" → Sense/"llm.prompt"
		// Corpus delivered a user message. Forward to LLMOrgan as a prompt.
		const offInput = nerve.motor.subscribe(MOTOR_TEXT_INPUT, (event) => {
			nerve.sense.publish({
				type: SENSE_LLM_PROMPT,
				payload: {
					messages: [{ role: "user", content: event.payload.text }],
					tools: event.payload.tools,
				},
				correlationId: event.correlationId,
				timestamp: Date.now(),
				isError: false,
			});
		});

		// Motor/"text.message" → Sense/"text.reply"
		// LLMOrgan sent its text reply. Forward back to Corpus.
		const offMessage = nerve.motor.subscribe(MOTOR_TEXT_MESSAGE, (event) => {
			nerve.sense.publish({
				type: SENSE_TEXT_REPLY,
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
