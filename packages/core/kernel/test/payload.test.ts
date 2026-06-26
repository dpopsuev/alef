/**
 * withLlmContent — typed helper for dual-channel tool results.
 *
 * Given/When/Then:
 *   Given a string LLM content and optional structured metadata
 *   When withLlmContent is called
 *   Then the result has content = the string (picked up by payloadToText)
 *     AND _display = the display block (picked up by TUI)
 *     AND any extra metadata is merged at the top level
 */

import { describe, expect, it } from "vitest";
import { withDisplay, withLlmContent } from "../src/payload.js";

describe("withLlmContent", { tags: ["unit"] }, () => {
	it("puts the content string in the 'content' field", () => {
		const result = withLlmContent("# Article body", {}, { text: "Title", mimeType: "text/markdown" });
		expect(result.content).toBe("# Article body");
	});

	it("attaches _display for TUI rendering", () => {
		const result = withLlmContent("body", {}, { text: "pill label", mimeType: "text/plain" });
		expect((result._display as { text: string }).text).toBe("pill label");
	});

	it("merges extra metadata at top level", () => {
		const result = withLlmContent(
			"body",
			{ url: "https://example.com", wordCount: 500 },
			{ text: "label", mimeType: "text/plain" },
		);
		expect(result.url).toBe("https://example.com");
		expect(result.wordCount).toBe(500);
		expect(result.content).toBe("body");
	});

	it("content wins over a 'content' key in metadata (prevents shadowing)", () => {
		const result = withLlmContent("correct", { content: "wrong" }, { text: "x", mimeType: "text/plain" });
		expect(result.content).toBe("correct");
	});

	it("is compatible with withDisplay — same _display shape", () => {
		const via_withDisplay = withDisplay({ content: "body" }, { text: "label", mimeType: "text/plain" });
		const via_withLlmContent = withLlmContent("body", {}, { text: "label", mimeType: "text/plain" });
		expect(via_withLlmContent._display).toEqual(via_withDisplay._display);
		expect(via_withLlmContent.content).toBe(via_withDisplay.content);
	});
});
