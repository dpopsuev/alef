import type { PhaseStageHandler } from "@dpopsuev/alef-organ-llm";
import type { BaseOrganOptions } from "@dpopsuev/alef-spine";
import { defineOrgan } from "@dpopsuev/alef-spine";
import type { SessionStore } from "./session-store.js";
import { assembleTurns, turnsToMessages } from "./turn-assembler.js";

export interface MemoryOrganOptions extends BaseOrganOptions {
	compactionThreshold?: number;
	recentGuarantee?: number;
	sessionStore?: () => SessionStore | undefined;
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

	return {
		...organBase,
		phaseStage(): PhaseStageHandler {
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
				const budgetUsed = selected.reduce((n, t) => n + t.tokenCost, 0);
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

				const assembled: RawMsg[] = [
					...(systemMsg ? [systemMsg] : []),
					...(projected as unknown as RawMsg[]),
					currentUserMsg,
				];

				return { messages: assembled as unknown as typeof messages };
			};
		},
	};
}
