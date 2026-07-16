import { describe, expect, it } from "vitest";
import { truncateToolArgsForSummary } from "../src/context/compaction.js";

describe("truncateToolArgsForSummary", { tags: ["unit"] }, () => {
	it("should truncate fs.write content to first/last 100 chars", () => {
		const longContent = "a".repeat(500);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "fs.write",
						input: {
							path: "test.txt",
							content: longContent,
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const result = truncated[0] as typeof messages[0];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const block = result.content[0] as { input: { content: string } };
		
		expect(block.input.content).toContain("…[truncated for summarization]");
		expect(block.input.content.length).toBeLessThan(longContent.length);
		// Should have first 100 + suffix + last 100
		expect(block.input.content.startsWith("a".repeat(100))).toBe(true);
		expect(block.input.content.endsWith("a".repeat(100))).toBe(true);
	});

	it("should truncate fs.edit oldText and newText to first 50 chars", () => {
		const longText = "b".repeat(200);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_2",
						name: "fs.edit",
						input: {
							path: "test.ts",
							oldText: longText,
							newText: longText,
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const result = truncated[0] as typeof messages[0];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const block = result.content[0] as { input: { oldText: string; newText: string } };

		expect(block.input.oldText).toContain("…[truncated for summarization]");
		expect(block.input.newText).toContain("…[truncated for summarization]");
		expect(block.input.oldText.length).toBeLessThan(longText.length);
		expect(block.input.newText.length).toBeLessThan(longText.length);
	});

	it("should not truncate small arguments", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_3",
						name: "fs.write",
						input: {
							path: "small.txt",
							content: "short content",
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const result = truncated[0] as typeof messages[0];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const block = result.content[0] as { input: { content: string } };

		expect(block.input.content).toBe("short content");
	});

	it("should not modify non-assistant messages", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Hello",
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		expect(truncated).toEqual(messages);
	});

	it("should not modify other tool calls", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_4",
						name: "shell.exec",
						input: {
							command: "ls -la " + "a".repeat(500),
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		expect(truncated).toEqual(messages);
	});

	it("should handle tool_use with arguments field instead of input", () => {
		const longContent = "c".repeat(500);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-use",
						id: "call_5",
						name: "fs_write",
						arguments: {
							path: "test.txt",
							content: longContent,
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const result = truncated[0] as typeof messages[0];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const block = result.content[0] as { arguments: { content: string } };

		expect(block.arguments.content).toContain("…[truncated for summarization]");
	});

	it("should handle mixed content blocks", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I will write a file",
					},
					{
						type: "tool_use",
						id: "call_6",
						name: "fs.write",
						input: {
							path: "big.txt",
							content: "d".repeat(500),
						},
					},
				],
			},
		];

		const truncated = truncateToolArgsForSummary(messages);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const result = truncated[0] as typeof messages[0];
		
		// Text block should be unchanged
		expect(result.content[0]).toEqual({ type: "text", text: "I will write a file" });
		
		// Tool use should be truncated
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const toolBlock = result.content[1] as { input: { content: string } };
		expect(toolBlock.input.content).toContain("…[truncated for summarization]");
	});
});
