import type { BaseOrganOptions, ContextAssemblyHandler } from "@dpopsuev/alef-kernel";
import { defineOrgan } from "@dpopsuev/alef-kernel";
import type { ISessionStore } from "@dpopsuev/alef-session";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY, turnsToMessages } from "@dpopsuev/alef-session";

export interface MemoryOrganOptions extends BaseOrganOptions {
	compactionThreshold?: number;
	recentGuarantee?: number;
	sessionStore?: () => ISessionStore | undefined;
	contextWindow?: number;
}

type RawMsg = { role: string; content: unknown };

export function createMemoryOrgan(opts: MemoryOrganOptions = {}) {
	const recentGuarantee = opts.recentGuarantee ?? 4;
	const contextWindow = opts.contextWindow ?? 128_000;

	const organBase = defineOrgan(
		"memory",
		{},
		{
			description: "Five-level memory pyramid: Now, Latest, Recent[N], Session, ROM.",
			directives: [],
			...opts,
		},
	);

	function phaseStageHandler(): ContextAssemblyHandler {
		return async ({ messages, turn: _turn }) => {
			const msgs = messages as unknown as RawMsg[];
			if (!msgs.length) return {};

			const session = opts.sessionStore?.();
			if (!session) return {};

			const systemMsg = msgs.find((m) => m.role === "system");
			const currentUserMsg = msgs.at(-1);
			if (!currentUserMsg) return {};

			const [turns, hitCounts] = await Promise.all([session.turns(), session.hitCounts()]);
			if (turns.length === 0) return {};

			const query = typeof currentUserMsg.content === "string" ? currentUserMsg.content : "";
			const selected = assembleTurns(turns, {
				query,
				contextWindow,
				hitCounts,
				policy: { recentGuarantee },
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

			// Guard: if turnsToMessages already ends with the current user message
			// (because the in-flight turn was recorded in the session store before
			// the phase pipeline runs), do not append it again — consecutive
			// same-role messages are rejected by the API.
			const projectedMsgs = projected as unknown as RawMsg[];
			const projectedLast = projectedMsgs.at(-1);
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

	const handler = phaseStageHandler();

	return {
		...organBase,
		contributions: { "context.assemble": handler },
		phaseStage(): ContextAssemblyHandler {
			return handler;
		},
	};
}
