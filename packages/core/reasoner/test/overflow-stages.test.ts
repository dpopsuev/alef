import { describe, expect, it } from "vitest";
import type { Message } from "@dpopsuev/alef-ai/types";
import {
	applyAggressiveReduction,
	applyEmergencyReduction,
	applyStageTransformation,
	canEscalate,
	classifyOverflowSeverity,
	escalateStage,
	getStageInstructions,
	OverflowStage,
	truncateToolArgs,
} from "../src/handlers/overflow.js";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantTextMessage(content: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { ...EMPTY_USAGE },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCallMessage(
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): Message {
	return {
		role: "assistant",
		content: toolCalls.map((toolCall) => ({ type: "toolCall" as const, ...toolCall })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { ...EMPTY_USAGE },
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function textContent(message: Message | undefined): string {
	if (!message) return "";
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
	}
	if (message.role === "assistant") {
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function assistantToolCalls(message: Message | undefined) {
	return message?.role === "assistant"
		? message.content.filter(
				(block): block is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
					block.type === "toolCall",
			)
		: [];
}

describe("Overflow recovery stages", { tags: ["unit"] }, () => {
	describe("classifyOverflowSeverity", () => {
		it("returns Standard for minor overflow (5-20%)", () => {
			expect(classifyOverflowSeverity(105000, 100000)).toBe(OverflowStage.Standard);
			expect(classifyOverflowSeverity(110000, 100000)).toBe(OverflowStage.Standard);
		});

		it("returns Aggressive for moderate overflow (20-50%)", () => {
			expect(classifyOverflowSeverity(121000, 100000)).toBe(OverflowStage.Aggressive);
			expect(classifyOverflowSeverity(140000, 100000)).toBe(OverflowStage.Aggressive);
		});

		it("returns ArgTruncation for severe overflow (50-150%)", () => {
			expect(classifyOverflowSeverity(151000, 100000)).toBe(OverflowStage.ArgTruncation);
			expect(classifyOverflowSeverity(180000, 100000)).toBe(OverflowStage.ArgTruncation);
		});

		it("returns Emergency for critical overflow (>150%)", () => {
			expect(classifyOverflowSeverity(200000, 100000)).toBe(OverflowStage.Emergency);
			expect(classifyOverflowSeverity(300000, 100000)).toBe(OverflowStage.Emergency);
		});
	});

	describe("stage escalation", () => {
		it("escalates from Standard to Aggressive", () => {
			expect(escalateStage(OverflowStage.Standard)).toBe(OverflowStage.Aggressive);
		});

		it("escalates from Aggressive to ArgTruncation", () => {
			expect(escalateStage(OverflowStage.Aggressive)).toBe(OverflowStage.ArgTruncation);
		});

		it("escalates from ArgTruncation to Emergency", () => {
			expect(escalateStage(OverflowStage.ArgTruncation)).toBe(OverflowStage.Emergency);
		});

		it("cannot escalate beyond Emergency", () => {
			expect(escalateStage(OverflowStage.Emergency)).toBe(OverflowStage.Emergency);
		});

		it("canEscalate returns true for non-Emergency stages", () => {
			expect(canEscalate(OverflowStage.Standard)).toBe(true);
			expect(canEscalate(OverflowStage.Aggressive)).toBe(true);
			expect(canEscalate(OverflowStage.ArgTruncation)).toBe(true);
		});

		it("canEscalate returns false for Emergency", () => {
			expect(canEscalate(OverflowStage.Emergency)).toBe(false);
		});
	});

	describe("getStageInstructions", () => {
		it("returns instructions for each stage", () => {
			expect(getStageInstructions(OverflowStage.Standard)).toContain("preserve goals");
			expect(getStageInstructions(OverflowStage.Aggressive)).toContain("last 2 turns");
			expect(getStageInstructions(OverflowStage.ArgTruncation)).toContain("truncate all tool arguments");
			expect(getStageInstructions(OverflowStage.Emergency)).toContain("most recent user message");
		});
	});

	describe("applyAggressiveReduction", () => {
		it("keeps last 2 non-system messages", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
				userMessage("msg3"),
				assistantTextMessage("msg4"),
				userMessage("msg5"),
			];

			applyAggressiveReduction(messages);

			expect(messages).toHaveLength(2);
			expect(textContent(messages[0])).toBe("msg4");
			expect(textContent(messages[1])).toBe("msg5");
		});

		it("does nothing when 2 or fewer messages", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
			];

			applyAggressiveReduction(messages);

			expect(messages).toHaveLength(2);
		});
	});

	describe("truncateToolArgs", () => {
		it("truncates long tool call arguments", () => {
			const longArgs = { data: "x".repeat(300), otherField: "value" };
			const messages: Message[] = [
				assistantToolCallMessage([
					{ id: "1", name: "tool1", arguments: longArgs },
					{ id: "2", name: "tool2", arguments: { short: "arg" } },
				]),
			];

			truncateToolArgs(messages);

			const firstTool = assistantToolCalls(messages[0])[0];
			expect(firstTool?.arguments).toHaveProperty("_truncated");
			expect(JSON.stringify(firstTool?.arguments)).toContain("...");

			const secondTool = assistantToolCalls(messages[0])[1];
			expect(secondTool?.arguments).toEqual({ short: "arg" });
		});

		it("does not modify messages without tool calls", () => {
			const messages: Message[] = [
				userMessage("hello"),
				assistantTextMessage("hi"),
			];

			truncateToolArgs(messages);

			expect(messages).toHaveLength(2);
			expect(messages[0]?.content).toBe("hello");
		});
	});

	describe("applyEmergencyReduction", () => {
		it("keeps only system message and last user message", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
				userMessage("msg3"),
				assistantTextMessage("msg4"),
			];

			applyEmergencyReduction(messages);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(textContent(messages[0])).toBe("msg3");
		});

		it("creates placeholder when no user message exists", () => {
			const messages: Message[] = [
				assistantTextMessage("msg1"),
			];

			applyEmergencyReduction(messages);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(textContent(messages[0])).toContain("Continue from where we left off");
		});

		it("works without system message", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
				userMessage("msg3"),
			];

			applyEmergencyReduction(messages);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(textContent(messages[0])).toBe("msg3");
		});
	});

	describe("applyStageTransformation", () => {
		it("does nothing for Standard stage", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
			];
			const original = JSON.parse(JSON.stringify(messages));

			applyStageTransformation(messages, OverflowStage.Standard);

			expect(messages).toEqual(original);
		});

		it("applies aggressive reduction for Aggressive stage", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
				userMessage("msg3"),
				assistantTextMessage("msg4"),
			];

			applyStageTransformation(messages, OverflowStage.Aggressive);

			expect(messages).toHaveLength(2);
		});

		it("applies truncation + reduction for ArgTruncation stage", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantToolCallMessage([{ id: "1", name: "tool", arguments: { data: "x".repeat(300) } }]),
				userMessage("msg3"),
			];

			applyStageTransformation(messages, OverflowStage.ArgTruncation);

			expect(messages).toHaveLength(2); // Reduced to last 2
			const toolCall = assistantToolCalls(messages[0])[0];
			expect(toolCall?.arguments).toHaveProperty("_truncated"); // Truncated
		});

		it("applies emergency reduction for Emergency stage", () => {
			const messages: Message[] = [
				userMessage("msg1"),
				assistantTextMessage("msg2"),
				userMessage("msg3"),
			];

			applyStageTransformation(messages, OverflowStage.Emergency);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(textContent(messages[0])).toBe("msg3");
		});
	});
});
