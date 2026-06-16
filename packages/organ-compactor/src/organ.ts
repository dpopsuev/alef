import type { ContextAssemblyHandler, ContextAssemblyOutput } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface CompactorOrganOptions {
	cwd: string;
	contextWindow?: number;
	threshold?: number;
	preserveRecentTurns?: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_PRESERVE_RECENT = 4;

function estimateTokens(messages: readonly unknown[]): number {
	let chars = 0;
	for (const msg of messages) {
		const m = msg as { content?: string | Array<{ text?: string }> };
		if (typeof m.content === "string") {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (typeof block.text === "string") chars += block.text.length;
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function summarizeMessages(messages: readonly unknown[]): string {
	const lines: string[] = ["[Context compacted — earlier turns summarized]", ""];
	for (const msg of messages) {
		const m = msg as { role?: string; content?: string | Array<{ text?: string }> };
		const role = m.role ?? "unknown";
		let text = "";
		if (typeof m.content === "string") {
			text = m.content;
		} else if (Array.isArray(m.content)) {
			text = m.content
				.filter((b): b is { text: string } => typeof b.text === "string")
				.map((b) => b.text)
				.join(" ");
		}
		if (!text) continue;
		const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
		lines.push(`- ${role}: ${firstLine.slice(0, 120)}`);
	}
	return lines.join("\n");
}

const STATS_TOOL = {
	name: "compactor.stats",
	description: "Show context compaction statistics: token estimates, threshold, compaction count.",
	inputSchema: z.object({}),
};

export function createCompactorOrgan(opts: CompactorOrganOptions) {
	const contextWindow = opts.contextWindow ?? 200_000;
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const preserveRecent = opts.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT;
	const tokenLimit = Math.floor(contextWindow * threshold);

	let compactionCount = 0;
	let lastEstimatedTokens = 0;
	let lastCompactedTokens = 0;

	const compactStage: ContextAssemblyHandler = async (input) => {
		const estimated = estimateTokens(input.messages);
		lastEstimatedTokens = estimated;

		if (estimated <= tokenLimit) {
			return {};
		}

		const messages = [...input.messages];
		const systemMsg = messages.find((m) => (m as { role?: string }).role === "system");
		const nonSystem = messages.filter((m) => (m as { role?: string }).role !== "system");

		if (nonSystem.length <= preserveRecent) {
			return {};
		}

		const toCompact = nonSystem.slice(0, -preserveRecent);
		const toKeep = nonSystem.slice(-preserveRecent);
		const summary = summarizeMessages(toCompact);

		const compactedMessages: unknown[] = [];
		if (systemMsg) compactedMessages.push(systemMsg);
		compactedMessages.push({ role: "user", content: summary });
		compactedMessages.push(...toKeep);

		compactionCount++;
		lastCompactedTokens = estimateTokens(compactedMessages);

		const result: ContextAssemblyOutput = { messages: compactedMessages };
		return result;
	};

	return defineOrgan(
		"compactor",
		{
			motor: {
				"compactor.stats": typedAction(STATS_TOOL, async () => {
					return withDisplay(
						{
							compactionCount,
							lastEstimatedTokens,
							lastCompactedTokens,
							tokenLimit,
							contextWindow,
							threshold,
							preserveRecent,
						},
						{
							text: [
								"Compaction stats:",
								`  Compactions: ${compactionCount}`,
								`  Last estimated: ${lastEstimatedTokens} tokens`,
								`  Last compacted: ${lastCompactedTokens} tokens`,
								`  Threshold: ${tokenLimit} tokens (${(threshold * 100).toFixed(0)}% of ${contextWindow})`,
							].join("\n"),
							mimeType: "text/plain",
						},
					);
				}),
			},
		},
		{
			description: "Context compaction — summarizes old turns when context exceeds threshold.",
			directives: [
				"The compactor automatically summarizes old conversation turns when context approaches the limit. " +
					"Use compactor.stats to check compaction metrics.",
			],
			labels: ["compactor", "context", "token-savings"],
			contributions: {
				"context.assemble": compactStage,
			},
		},
	);
}
