/**
 * LLM session title — short label for the upper delimiter on first prompt.
 */

import { clampTitleWords, TITLE_WORD_MAX, TITLE_WORD_MIN } from "./metadata.js";
import type { SummarizerComplete } from "./summarizer.js";

const TITLE_SYSTEM_PROMPT =
	"You name chat sessions. Reply with ONLY a title of 2 to 5 words. " +
	"No quotes, no punctuation, no explanation, no trailing period.";

const TITLE_USER_TEMPLATE = `Name this conversation from the user's first message.

<message>
{message}
</message>

Title (${TITLE_WORD_MIN}-${TITLE_WORD_MAX} words):`;

const MESSAGE_MAX_CHARS = 800;

/**
 * Build an async title generator. Falls back to a 2–5 word heuristic on failure.
 */
export function createLlmTitleGenerator(
	complete: SummarizerComplete,
): (prompt: string) => Promise<string | undefined> {
	return async (prompt) => {
		const fallback = clampTitleWords(prompt);
		const excerpt = prompt.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX_CHARS);
		if (!excerpt) return fallback;
		try {
			const response = await complete({
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: TITLE_USER_TEMPLATE.replace("{message}", excerpt),
						timestamp: Date.now(),
					},
				],
			});
			const raw = response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("")
				.split("\n")[0]
				?.trim();
			return (raw ? clampTitleWords(raw) : undefined) ?? fallback;
		} catch {
			return fallback;
		}
	};
}
