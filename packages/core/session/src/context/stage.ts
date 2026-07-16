import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import type { SessionStore } from "../contracts/storage.js";
import {
	assembleTurns,
	DEFAULT_CONTEXT_WINDOW_POLICY,
	DEFAULT_RECENT_GUARANTEE,
	HISTORY_BUDGET_FRACTION,
	turnsToMessages,
} from "./assembler.js";
import { eventsAfterCompaction, latestCompaction } from "./compaction.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 *
 */
export interface SessionContextStageOptions {
	sessionStore: () => SessionStore | undefined;
	contextWindow?: number;
}

type RawMsg = { role: string; content: unknown };

/**
 *
 */
function summaryUserMessage(summary: string): RawMsg & { timestamp: number } {
	return {
		role: "user",
		content: [{ type: "text", text: summary }],
		timestamp: Date.now(),
	};
}

/**
 *
 */
export function createSessionContextStage(opts: SessionContextStageOptions): ContextAssemblyHandler {
	const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

	return async ({ messages }) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- context assembly messages to internal RawMsg shape
		const msgs = messages as unknown as RawMsg[];
		if (!msgs.length) return {};

		const session = opts.sessionStore();
		if (!session) return {};

		const currentUserMsg = msgs.at(-1);
		if (!currentUserMsg) return {};

		const [turns, hitCounts, events] = await Promise.all([
			session.turns(),
			session.hitCounts(),
			session.events(),
		]);
		if (turns.length === 0) return {};

		const compaction = latestCompaction(events);
		const keptEventIds = compaction
			? new Set(
					eventsAfterCompaction(events, compaction)
						.map((e) => e.hash)
						.filter((h): h is string => typeof h === "string"),
				)
			: undefined;

		const query = typeof currentUserMsg.content === "string" ? currentUserMsg.content : "";
		let selected = assembleTurns(turns, {
			query,
			contextWindow,
			hitCounts,
			policy: { recentGuarantee: DEFAULT_RECENT_GUARANTEE },
		});
		if (keptEventIds && keptEventIds.size > 0) {
			selected = selected.filter((turn) => turn.events.some((e) => e.hash && keptEventIds.has(e.hash)));
		} else if (compaction) {
			const kept = eventsAfterCompaction(events, compaction);
			const keptTimestamps = new Set(kept.map((e) => e.timestamp));
			selected = selected.filter((turn) => turn.events.some((e) => keptTimestamps.has(e.timestamp)));
		}
		if (selected.length === 0 && !compaction) return {};

		const budgetTotal = Math.floor(contextWindow * HISTORY_BUDGET_FRACTION);
		const maxSingleTurnCost = Math.floor(budgetTotal * DEFAULT_CONTEXT_WINDOW_POLICY.maxSingleTurnFraction);
		const budgetUsed = selected.reduce((n, t) => n + Math.min(t.tokenCost, maxSingleTurnCost), 0);
		void session.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: `wa-${Date.now()}`,
			payload: {
				includedTurnIds: selected.map((t) => t.id),
				queryTokens: query
					.toLowerCase()
					.split(/\W+/)
					.filter((t) => t.length > 2),
				budgetUsed,
				budgetTotal,
			},
			timestamp: Date.now(),
		});

		const projected = turnsToMessages(selected);
		const summary =
			compaction && typeof compaction.payload.summary === "string" ? compaction.payload.summary : undefined;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Message[] to internal RawMsg shape
		const projectedMsgs = projected as unknown as RawMsg[];
		const projectedLast = projectedMsgs.at(-1);
		const systemMsg = msgs.find((m) => m.role === "system");
		const alreadyAppended =
			projectedLast?.role === currentUserMsg.role && projectedLast.content === currentUserMsg.content;

		const assembled: RawMsg[] = [
			...(systemMsg ? [systemMsg] : []),
			...(summary ? [summaryUserMessage(summary)] : []),
			...projectedMsgs,
			...(!alreadyAppended && currentUserMsg.role === "user" ? [currentUserMsg] : []),
		];

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RawMsg[] back to context assembly message type
		return { messages: assembled as unknown as typeof messages };
	};
}
