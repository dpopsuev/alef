import {
	type CompactionResult,
	compactMessages,
	estimateTokens,
	latestCompaction,
	type SummarizeFn,
} from "@dpopsuev/alef-session/compaction";
import type { SessionStore } from "@dpopsuev/alef-session/storage";

/** Keep budget for manual :compact when history is already under the auto threshold. */
export const MANUAL_COMPACT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Run an immediate, durable compaction using the injected summarizer.
 * Always forces a cut when there are ≥2 non-system messages — no stub path.
 */
export async function runManualCompact(opts: {
	store: SessionStore;
	summarize: SummarizeFn;
	instructions?: string;
	keepRecentTokens?: number;
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
	const { result } = await compactMessages(messages, {
		keepRecentTokens: opts.keepRecentTokens ?? MANUAL_COMPACT_KEEP_RECENT_TOKENS,
		summarize: opts.summarize,
		priorSummary,
		instructions: opts.instructions,
		sessionStore: opts.store,
		estimatedBefore: estimateTokens(messages),
		force: true,
	});

	if (result.compactedTurns === 0) {
		return { result, notice: "(nothing to compact — need at least two turns)" };
	}

	return {
		result,
		notice: `(compacted ${result.compactedTurns} messages → ~${result.estimatedAfter} tokens)`,
	};
}
