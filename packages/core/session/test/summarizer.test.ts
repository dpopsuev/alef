import { describe, expect, it } from "vitest";
import { createLlmSummarizer, type SummarizerCompleteInput } from "../src/context/summarizer.js";

describe("createLlmSummarizer", { tags: ["unit"] }, () => {
	it("uses injected complete and returns joined text", async () => {
		const calls: SummarizerCompleteInput[] = [];
		const summarize = createLlmSummarizer(async (input) => {
			calls.push(input);
			return {
				content: [
					{ type: "text", text: "## Goal\nShip the fix" },
					{ type: "thinking", text: "ignored" },
				],
			};
		});

		const result = await summarize([{ role: "user", content: "fix the bug" }]);

		expect(result).toBe("## Goal\nShip the fix");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.systemPrompt).toContain("summarization");
		expect(calls[0]?.messages[0]?.content).toContain("fix the bug");
	});

	it("falls back when complete throws", async () => {
		const summarize = createLlmSummarizer(async () => {
			throw new Error("provider down");
		});

		const result = await summarize([{ role: "user", content: "hello world\nmore" }]);

		expect(result).toContain("- user: hello world");
	});
});
