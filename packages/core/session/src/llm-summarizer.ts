import type { Api, Model } from "@dpopsuev/alef-llm";
import { completeSimple } from "@dpopsuev/alef-llm";

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Read the conversation and produce a structured summary. Do NOT continue the conversation.";

const SUMMARIZATION_USER_TEMPLATE = `<conversation>
{conversation}
</conversation>

Summarize this conversation. Use this format:

## Goal
[What the user is trying to accomplish]

## Progress
- [x] [Completed items]
- [ ] [In progress items]

## Key Decisions
- [Important decisions made]

## Next Steps
1. [What should happen next]

Keep it concise. Preserve exact file paths and function names.`;

const MESSAGE_PREVIEW_MAX_CHARS = 500;
const FALLBACK_MESSAGE_COUNT = 10;
const FALLBACK_LINE_MAX_CHARS = 120;

function formatConversation(messages: readonly unknown[]): string {
	return messages
		.map((m) => {
			const msg = m as { role?: string; content?: string | Array<{ text?: string }> };
			const role = msg.role ?? "unknown";
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content))
				text = msg.content
					.filter((b): b is { text: string } => typeof b.text === "string")
					.map((b) => b.text)
					.join(" ");
			return `[${role}] ${text.slice(0, MESSAGE_PREVIEW_MAX_CHARS)}`;
		})
		.join("\n");
}

function fallbackSummary(messages: readonly unknown[]): string {
	return messages
		.slice(0, FALLBACK_MESSAGE_COUNT)
		.map((m) => {
			const msg = m as { role?: string; content?: string };
			return `- ${msg.role ?? "?"}: ${typeof msg.content === "string" ? msg.content.split("\n")[0]?.slice(0, FALLBACK_LINE_MAX_CHARS) : "..."}`;
		})
		.join("\n");
}

export function createLlmSummarizer(model: Model<Api>): (messages: readonly unknown[]) => Promise<string> {
	return async (messages) => {
		const conversation = formatConversation(messages);
		try {
			const response = await completeSimple(model, {
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: SUMMARIZATION_USER_TEMPLATE.replace("{conversation}", conversation),
						timestamp: Date.now(),
					},
				],
			});
			const text = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			return text || "[Context compacted — earlier turns summarized]";
		} catch {
			return fallbackSummary(messages);
		}
	};
}
