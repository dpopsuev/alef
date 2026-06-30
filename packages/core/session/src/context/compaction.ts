import type { ContextAssemblyHandler, ContextAssemblyOutput } from "@dpopsuev/alef-kernel/context-assembly";

export type SummarizeFn = (messages: readonly unknown[]) => Promise<string> | string;

export interface CompactionResult {
	compactedTurns: number;
	preservedTurns: number;
	estimatedBefore: number;
	estimatedAfter: number;
}

export interface CompactionStageOptions {
	contextWindow?: number;
	threshold?: number;
	preserveRecentTurns?: number;
	summarize?: SummarizeFn;
	onCompact?: (result: CompactionResult) => void;
	/** Publish a signal event (wired by the agent after mount). */
	publishSignal?: (type: string, payload: Record<string, unknown>) => void;
	/** Returns the real token count from the last API response. When provided, takes precedence over char estimation. */
	getLastTokenCount?: () => number;
}

const CHARS_PER_TOKEN = 4;
const SUMMARY_LINE_MAX_LENGTH = 120;
const DEFAULT_COMPACTION_THRESHOLD = 0.9;
const DEFAULT_PRESERVE_RECENT = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const SCRATCHPAD_PREFIX = "[Scratchpad";

function estimateTokens(messages: readonly unknown[]): number {
	let chars = 0;
	for (const msg of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for content access
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

function defaultSummarize(messages: readonly unknown[]): string {
	const lines: string[] = ["[Context compacted — earlier turns summarized]", ""];
	for (const msg of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for role/content access
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
		lines.push(`- ${role}: ${firstLine.slice(0, SUMMARY_LINE_MAX_LENGTH)}`);
	}
	return lines.join("\n");
}

function injectPriorSummary(messages: readonly unknown[], summary: string): ContextAssemblyOutput {
	const result = [...messages];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for role check
	const systemIdx = result.findIndex((m) => (m as { role?: string }).role === "system");
	const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
	result.splice(insertAt, 0, { role: "user", content: summary });
	return { messages: result };
}

export function createCompactionStage(opts: CompactionStageOptions = {}): ContextAssemblyHandler {
	const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const threshold = opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
	const preserveRecent = opts.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT;
	const tokenLimit = Math.floor(contextWindow * threshold);
	const summarizeFn: SummarizeFn = opts.summarize ?? defaultSummarize;
	const onCompact = opts.onCompact;
	const publishSignal = opts.publishSignal;
	const getLastTokenCount = opts.getLastTokenCount;

	let lastSummary = "";

	return async (input) => {
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0 tokens means no data, must fall through to estimation
		const estimated = getLastTokenCount?.() || estimateTokens(input.messages);

		if (estimated <= tokenLimit) {
			if (lastSummary) {
				return injectPriorSummary(input.messages, lastSummary);
			}
			return {};
		}

		const messages = [...input.messages];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for role check
		const systemMsg = messages.find((m) => (m as { role?: string }).role === "system");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for role check
		const nonSystem = messages.filter((m) => (m as { role?: string }).role !== "system");

		if (nonSystem.length <= preserveRecent) {
			return {};
		}

		const oldMessages = nonSystem.slice(0, -preserveRecent);
		const toKeep = nonSystem.slice(-preserveRecent);

		const isScratchpad = (m: unknown) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message for content check
			const content = (m as { content?: string }).content;
			return typeof content === "string" && content.startsWith(SCRATCHPAD_PREFIX);
		};
		const preserved = oldMessages.filter(isScratchpad);
		const toCompact = oldMessages.filter((m) => !isScratchpad(m));
		const summary = await summarizeFn(toCompact);

		const compactedMessages: unknown[] = [];
		if (systemMsg) compactedMessages.push(systemMsg);
		compactedMessages.push(...preserved);
		compactedMessages.push({ role: "user", content: summary });
		compactedMessages.push(...toKeep);

		lastSummary = summary;

		const result: CompactionResult = {
			compactedTurns: toCompact.length,
			preservedTurns: toKeep.length,
			estimatedBefore: estimated,
			estimatedAfter: estimateTokens(compactedMessages),
		};
		onCompact?.(result);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CompactionResult to generic signal payload
		publishSignal?.("context.compacted", result as unknown as Record<string, unknown>);

		return { messages: compactedMessages };
	};
}
