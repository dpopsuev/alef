import type { ContextAssemblyHandler, ContextAssemblyOutput } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export type SummarizeFn = (messages: readonly unknown[]) => Promise<string> | string;

export interface CompactorOrganOptions {
	cwd: string;
	contextWindow?: number;
	threshold?: number;
	preserveRecentTurns?: number;
	summarize?: SummarizeFn;
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

interface CompactionEntry {
	timestamp: number;
	messagesCompacted: number;
	tokensBefore: number;
	tokensAfter: number;
	summary: string;
}

const STATS_TOOL = {
	name: "compactor.stats",
	description: "Show context compaction statistics: token estimates, threshold, compaction count, history.",
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
	const compactionHistory: CompactionEntry[] = [];
	let lastSummary = "";
	const summarizeFn: SummarizeFn = opts.summarize ?? summarizeMessages;

	const compactStage: ContextAssemblyHandler = async (input) => {
		const estimated = estimateTokens(input.messages);
		lastEstimatedTokens = estimated;

		if (estimated <= tokenLimit) {
			if (lastSummary) {
				return injectPriorSummary(input.messages, lastSummary);
			}
			return {};
		}

		const messages = [...input.messages];
		const systemMsg = messages.find((m) => (m as { role?: string }).role === "system");
		const nonSystem = messages.filter((m) => (m as { role?: string }).role !== "system");

		if (nonSystem.length <= preserveRecent) {
			return {};
		}

		const oldMessages = nonSystem.slice(0, -preserveRecent);
		const toKeep = nonSystem.slice(-preserveRecent);

		const isScratchpad = (m: unknown) => {
			const content = (m as { content?: string }).content;
			return typeof content === "string" && content.startsWith("[Scratchpad");
		};
		const preserved = oldMessages.filter(isScratchpad);
		const toCompact = oldMessages.filter((m) => !isScratchpad(m));
		const summary = await summarizeFn(toCompact);

		const compactedMessages: unknown[] = [];
		if (systemMsg) compactedMessages.push(systemMsg);
		compactedMessages.push(...preserved);
		compactedMessages.push({ role: "user", content: summary });
		compactedMessages.push(...toKeep);

		compactionCount++;
		lastCompactedTokens = estimateTokens(compactedMessages);
		lastSummary = summary;

		compactionHistory.push({
			timestamp: Date.now(),
			messagesCompacted: toCompact.length,
			tokensBefore: estimated,
			tokensAfter: lastCompactedTokens,
			summary: summary.slice(0, 200),
		});

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
							historyLength: compactionHistory.length,
							history: compactionHistory.slice(-5),
						},
						{
							text: [
								"Compaction stats:",
								`  Compactions: ${compactionCount}`,
								`  Last estimated: ${lastEstimatedTokens} tokens`,
								`  Last compacted: ${lastCompactedTokens} tokens`,
								`  Threshold: ${tokenLimit} tokens (${(threshold * 100).toFixed(0)}% of ${contextWindow})`,
								`  History entries: ${compactionHistory.length}`,
								`  Session model: append-only (originals preserved in session store)`,
							].join("\n"),
							mimeType: "text/plain",
						},
					);
				}),
			},
		},
		{
			description:
				"Context compaction — summarizes old turns when context exceeds threshold. Append-only: originals preserved in session store.",
			directives: [
				"The compactor automatically summarizes old conversation turns when context approaches the limit. " +
					"Use compactor.stats to check compaction metrics and history.",
			],
			labels: ["compactor", "context", "token-savings"],
			contributions: {
				"context.assemble": compactStage,
			},
		},
	);
}

function injectPriorSummary(messages: readonly unknown[], summary: string): ContextAssemblyOutput {
	const result = [...messages];
	const systemIdx = result.findIndex((m) => (m as { role?: string }).role === "system");
	const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
	result.splice(insertAt, 0, { role: "user", content: summary });
	return { messages: result };
}
