import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel";
import type { SessionStore } from "./session-store.js";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY, turnsToMessages } from "./turn-assembler.js";

export interface SessionContextStageOptions {
	sessionStore: () => SessionStore | undefined;
	contextWindow?: number;
}

type RawMsg = { role: string; content: unknown };

export function createSessionContextStage(opts: SessionContextStageOptions): ContextAssemblyHandler {
	const contextWindow = opts.contextWindow ?? 128_000;

	return async ({ messages }) => {
		const msgs = messages as unknown as RawMsg[];
		if (!msgs.length) return {};

		const session = opts.sessionStore();
		if (!session) return {};

		const currentUserMsg = msgs.at(-1);
		if (!currentUserMsg) return {};

		const [turns, hitCounts] = await Promise.all([session.turns(), session.hitCounts()]);
		if (turns.length === 0) return {};

		const query = typeof currentUserMsg.content === "string" ? currentUserMsg.content : "";
		const selected = assembleTurns(turns, {
			query,
			contextWindow,
			hitCounts,
			policy: { recentGuarantee: 4 },
		});
		if (selected.length === 0) return {};

		const budgetTotal = Math.floor(contextWindow * 0.7);
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
		if (projected.length === 0) return {};

		const projectedMsgs = projected as unknown as RawMsg[];
		const projectedLast = projectedMsgs.at(-1);
		const systemMsg = msgs.find((m) => m.role === "system");
		const alreadyAppended =
			projectedLast?.role === currentUserMsg.role && projectedLast?.content === currentUserMsg.content;

		const assembled: RawMsg[] = [
			...(systemMsg ? [systemMsg] : []),
			...projectedMsgs,
			...(!alreadyAppended && currentUserMsg.role === "user" ? [currentUserMsg] : []),
		];

		return { messages: assembled as unknown as typeof messages };
	};
}
