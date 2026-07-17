import {
	type CompactionResult,
	type CompactionStrategy,
	compactMessages,
	estimateTokens,
	latestCompaction,
	type SummarizeFn,
} from "@dpopsuev/alef-session/compaction";
import type { SessionStore } from "@dpopsuev/alef-session/storage";

/** Keep budget for manual :compact when history is already under the auto threshold. */
export const MANUAL_COMPACT_KEEP_RECENT_TOKENS = 20_000;

/** Parse `:compact [--strategy=summarize|shake] [instructions…]`. */
export function parseCompactArgs(args: readonly string[]): {
	strategy: Exclude<CompactionStrategy, "off" | "attention">;
	instructions?: string;
} {
	let strategy: Exclude<CompactionStrategy, "off" | "attention"> = "summarize";
	const rest: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("--strategy=")) {
			const value = arg.slice("--strategy=".length);
			if (value === "shake" || value === "summarize") strategy = value;
			continue;
		}
		rest.push(arg);
	}
	const instructions = rest.join(" ").trim() || undefined;
	return { strategy, instructions };
}

/**
 * Run an immediate, durable compaction using the injected summarizer.
 * Always forces a cut when there are ≥2 non-system messages — no stub path.
 * Default strategy is summarize; pass strategy=shake for deterministic elision.
 */
export async function runManualCompact(opts: {
	store: SessionStore;
	summarize: SummarizeFn;
	instructions?: string;
	keepRecentTokens?: number;
	strategy?: Exclude<CompactionStrategy, "off" | "attention">;
}): Promise<{ result: CompactionResult; notice: string }> {
	const events = await opts.store.events();
	let messages: unknown[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!;
		if (event.type !== "llm.response" && event.type !== "llm.checkpoint") continue;
		const history = event.payload.conversationHistory;
		if (Array.isArray(history) && history.length > 0) {
			messages = history;
			break;
		}
	}
	if (messages.length === 0) {
		return {
			result: {
				compactedTurns: 0,
				preservedTurns: 0,
				estimatedBefore: 0,
				estimatedAfter: 0,
				summary: "",
			},
			notice: "(nothing to compact)",
		};
	}

	const prior = latestCompaction(events);
	const priorSummary = prior && typeof prior.payload.summary === "string" ? prior.payload.summary : undefined;
	const strategy = opts.strategy ?? "summarize";
	const { result } = await compactMessages(messages, {
		keepRecentTokens: opts.keepRecentTokens ?? MANUAL_COMPACT_KEEP_RECENT_TOKENS,
		summarize: opts.summarize,
		priorSummary,
		instructions: opts.instructions,
		sessionStore: opts.store,
		estimatedBefore: estimateTokens(messages),
		force: true,
		strategy,
	});

	if (result.compactedTurns === 0) {
		return { result, notice: "(nothing to compact — need at least two turns)" };
	}

	return {
		result,
		notice: `(compacted ${result.compactedTurns} messages → ~${result.estimatedAfter} tokens [${strategy}])`,
	};
}
