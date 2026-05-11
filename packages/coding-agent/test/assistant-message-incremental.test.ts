/**
 * Tests for AssistantMessageComponent incremental update optimization.
 *
 * Verifies that:
 * - Content blocks are reused (setText) instead of rebuilt when structure is stable
 * - Structure changes trigger full rebuild
 * - updateDisplayText() updates specific slots
 * - Edge cases (empty content, tool calls, errors) work correctly
 */

import type { AssistantMessage } from "@dpopsuev/alef-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

describe("AssistantMessageComponent — incremental updates", () => {
	it("renders text content", () => {
		const comp = new AssistantMessageComponent();
		const msg = makeMessage({
			content: [{ type: "text", text: "Hello world" }],
		});
		comp.updateContent(msg);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Hello world");
	});

	it("incremental update reuses components (no structure change)", () => {
		const comp = new AssistantMessageComponent();

		// First render
		const msg1 = makeMessage({
			content: [{ type: "text", text: "Hello" }],
		});
		comp.updateContent(msg1);
		comp.render(80);

		// Second render — same structure, different text
		const msg2 = makeMessage({
			content: [{ type: "text", text: "Hello World" }],
		});
		comp.updateContent(msg2);
		const lines2 = comp.render(80);

		expect(lines2.join("\n")).toContain("Hello World");
		expect(lines2.join("\n")).not.toContain("Hello\n"); // Old text replaced
	});

	it("structural change triggers full rebuild", () => {
		const comp = new AssistantMessageComponent();

		// Single text block
		comp.updateContent(
			makeMessage({
				content: [{ type: "text", text: "First" }],
			}),
		);

		// Add a second text block — structure changed
		comp.updateContent(
			makeMessage({
				content: [
					{ type: "text", text: "First" },
					{ type: "text", text: "Second" },
				],
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("First");
		expect(joined).toContain("Second");
	});

	it("updateDisplayText() updates a specific content block", () => {
		const comp = new AssistantMessageComponent();

		comp.updateContent(
			makeMessage({
				content: [{ type: "text", text: "Full text here" }],
			}),
		);

		// Simulate streaming buffer showing partial text
		comp.updateDisplayText(0, "Full te");

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Full te");
		// Should NOT contain the full text since display was overridden
		expect(joined).not.toContain("Full text here");
	});

	it("updateDisplayText() on non-existent index is a no-op", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(
			makeMessage({
				content: [{ type: "text", text: "Hello" }],
			}),
		);

		// Index 5 doesn't exist — should not crash
		comp.updateDisplayText(5, "Ghost");

		const lines = comp.render(80);
		expect(lines.join("\n")).toContain("Hello");
	});

	it("handles empty content gracefully", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(makeMessage({ content: [] }));

		const lines = comp.render(80);
		// Should not crash, may produce empty or minimal output
		expect(lines).toBeDefined();
	});

	it("handles whitespace-only text content", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(
			makeMessage({
				content: [{ type: "text", text: "   " }],
			}),
		);

		const lines = comp.render(80);
		// Whitespace-only is trimmed — should not render
		expect(lines.join("").trim()).toBe("");
	});

	it("handles aborted message", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(
			makeMessage({
				content: [{ type: "text", text: "Partial response" }],
				stopReason: "aborted",
				errorMessage: "User cancelled",
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Partial response");
	});

	it("handles error message", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(
			makeMessage({
				content: [],
				stopReason: "error",
				errorMessage: "Rate limited",
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Rate limited");
	});

	it("thinking block renders when not hidden", () => {
		const comp = new AssistantMessageComponent(undefined, false);
		comp.updateContent(
			makeMessage({
				content: [{ type: "thinking", thinking: "Let me think about this..." }],
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Let me think");
	});

	it("thinking block shows label when hidden", () => {
		const comp = new AssistantMessageComponent(undefined, true);
		comp.updateContent(
			makeMessage({
				content: [{ type: "thinking", thinking: "Secret thoughts" }],
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Thinking...");
		expect(joined).not.toContain("Secret thoughts");
	});

	it("toggle hideThinkingBlock updates rendering", () => {
		const comp = new AssistantMessageComponent(undefined, false);
		comp.updateContent(
			makeMessage({
				content: [{ type: "thinking", thinking: "Thoughts" }],
			}),
		);

		let lines = comp.render(80);
		expect(lines.join("\n")).toContain("Thoughts");

		comp.setHideThinkingBlock(true);
		lines = comp.render(80);
		expect(lines.join("\n")).toContain("Thinking...");
		expect(lines.join("\n")).not.toContain("Thoughts");
	});

	it("mixed content: thinking + text + tool call", () => {
		const comp = new AssistantMessageComponent();
		comp.updateContent(
			makeMessage({
				content: [
					{ type: "thinking", thinking: "Planning..." },
					{ type: "text", text: "I will help you." },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
				],
			}),
		);

		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Planning...");
		expect(joined).toContain("I will help you.");
	});
});
