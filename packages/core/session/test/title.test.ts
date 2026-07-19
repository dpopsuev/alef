import { describe, expect, it, vi } from "vitest";
import { clampTitleWords } from "../src/context/metadata.js";
import { createLlmTitleGenerator } from "../src/context/title.js";

describe("clampTitleWords", { tags: ["unit"] }, () => {
	it("keeps two to five words", () => {
		expect(clampTitleWords("Fix picker")).toBe("Fix picker");
		expect(clampTitleWords("a b c d e f")).toBe("a b c d e");
	});

	it("strips quotes and trailing punctuation", () => {
		expect(clampTitleWords('"Codebase explore path."')).toBe("Codebase explore path");
	});

	it("rejects slash commands and single words", () => {
		expect(clampTitleWords(":compact now")).toBeUndefined();
		expect(clampTitleWords("Alone")).toBeUndefined();
	});
});

describe("createLlmTitleGenerator", { tags: ["unit"] }, () => {
	it("clamps the model reply to five words", async () => {
		const complete = vi.fn(async () => ({
			content: [{ type: "text", text: "Deep multi agent codebase exploration journey" }],
		}));
		const titleFromPrompt = createLlmTitleGenerator(complete);
		await expect(titleFromPrompt("Explroe the code base using multiple agents.")).resolves.toBe(
			"Deep multi agent codebase exploration",
		);
		expect(complete).toHaveBeenCalledOnce();
	});

	it("falls back to heuristic when the model fails", async () => {
		const titleFromPrompt = createLlmTitleGenerator(async () => {
			throw new Error("offline");
		});
		await expect(titleFromPrompt("Explore the code base using multiple agents.")).resolves.toBe(
			"Explore the code base using",
		);
	});

	it("falls back when the model returns a one-word answer", async () => {
		const titleFromPrompt = createLlmTitleGenerator(async () => ({
			content: [{ type: "text", text: "Explore" }],
		}));
		await expect(titleFromPrompt("Explore the code base tonight")).resolves.toBe(
			"Explore the code base tonight",
		);
	});
});
