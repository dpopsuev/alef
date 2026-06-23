import type { Message } from "@dpopsuev/alef-llm";
import type { Turn } from "./session-store.js";

export interface ContextWindowPolicy {
	/**
	 * Fraction of model.contextWindow allocated to history.
	 * Remainder reserved for system prompt, tools, current message, LLM reply.
	 * Default: 0.70
	 */
	historyFraction: number;

	/**
	 * No single turn may consume more than this fraction of historyBudget.
	 * Prevents one large file read from crowding out all other context.
	 * Default: 0.25
	 */
	maxSingleTurnFraction: number;

	recentGuarantee: number;
	queryMatchWeight: number;
	accessFrequencyWeight: number;

	/**
	 * Weight for ordinal recency (turn index, not wall-clock). Default: 0.30
	 * Wall-clock time is NOT used — it's a false metric for semantic relevance.
	 */
	sessionRecencyWeight: number;
}

export const DEFAULT_CONTEXT_WINDOW_POLICY: ContextWindowPolicy = {
	historyFraction: 0.7,
	maxSingleTurnFraction: 0.25,
	recentGuarantee: 4,
	queryMatchWeight: 0.4,
	accessFrequencyWeight: 0.3,
	sessionRecencyWeight: 0.3,
};

function termOverlap(turn: Turn, queryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	const haystack = turn.events
		.flatMap((e) => Object.values(e.payload))
		.filter((v): v is string => typeof v === "string")
		.join(" ")
		.toLowerCase();

	let hits = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) hits++;
	}
	return hits / queryTokens.length;
}

function normalize(value: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(1, value / max);
}

function scoreTurn(
	turn: Turn,
	queryTokens: string[],
	hitCounts: Map<string, number>,
	maxHitCount: number,
	policy: ContextWindowPolicy,
	vectorScores?: Map<string, number>,
): number {
	const overlap = termOverlap(turn, queryTokens);
	const hitFreq = normalize(hitCounts.get(turn.id) ?? 1, maxHitCount);
	const recency = turn.turnIndex;
	const vectorSimilarity = vectorScores?.get(turn.id) ?? 0;

	return (
		policy.queryMatchWeight * overlap +
		policy.accessFrequencyWeight * hitFreq +
		policy.sessionRecencyWeight * recency +
		turn.typeWeight +
		vectorSimilarity * 0.5
	);
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 2);
}

export interface AssembleOptions {
	query: string;
	contextWindow: number;
	policy?: Partial<ContextWindowPolicy>;
	hitCounts?: Map<string, number>;
	vectorScores?: Map<string, number>;
}

export function assembleTurns(turns: Turn[], opts: AssembleOptions): Turn[] {
	if (turns.length === 0) return [];

	const policy = { ...DEFAULT_CONTEXT_WINDOW_POLICY, ...opts.policy };
	const hitCounts = opts.hitCounts ?? new Map<string, number>();
	const historyBudget = Math.floor(opts.contextWindow * policy.historyFraction);
	const maxSingleTurnCost = Math.floor(historyBudget * policy.maxSingleTurnFraction);

	const recentCount = Math.min(policy.recentGuarantee, turns.length);
	const recentTurns = turns.slice(-recentCount);
	const recentIds = new Set(recentTurns.map((t) => t.id));
	const candidateTurns = turns.slice(0, -recentCount);

	let remaining = historyBudget - recentTurns.reduce((n, t) => n + Math.min(t.tokenCost, maxSingleTurnCost), 0);
	const included: Turn[] = [...recentTurns];

	if (remaining <= 0 || candidateTurns.length === 0) {
		return recentTurns.slice().sort((a, b) => a.turnIndex - b.turnIndex);
	}

	const queryTokens = tokenize(opts.query);
	const maxHitCount = Math.max(1, ...Array.from(hitCounts.values()));
	const maxTurnIndex = Math.max(1, turns.at(-1)?.turnIndex ?? 1);

	const vectorScores = opts.vectorScores;
	const scored = candidateTurns.map((turn) => {
		const rawScore = scoreTurn(
			turn,
			queryTokens,
			hitCounts,
			maxHitCount,
			{
				...policy,
				sessionRecencyWeight: policy.sessionRecencyWeight * (turn.turnIndex / maxTurnIndex),
			},
			vectorScores,
		);
		const cost = Math.min(turn.tokenCost, maxSingleTurnCost);
		return { turn, score: rawScore, cost, evictionPriority: cost > 0 ? rawScore / cost : 0 };
	});

	scored.sort((a, b) => b.evictionPriority - a.evictionPriority);

	for (const { turn, cost } of scored) {
		if (cost > remaining) continue;
		if (recentIds.has(turn.id)) continue;
		included.push(turn);
		remaining -= cost;
		if (remaining <= 0) break;
	}

	return included.sort((a, b) => a.turnIndex - b.turnIndex);
}

/**
 * Project selected turns into a Message array for the Reasoner.
 *
 * Three paths, tried in order:
 *
 * 1. Primary — most recent command/llm.response with conversationHistory.
 *    Published by the Reasoner at the end of each completed turn; contains
 *    the full tool_use / tool_result block sequence.
 *
 * 2. Aborted-turn supplement — any turns after the primary checkpoint that
 *    have command/event tool-call pairs but no llm.response (the agent was
 *    interrupted mid-generation after all tool calls completed). Their work
 *    is injected as a synthetic user context message so the next LLM call
 *    is not amnesiac about what was done.
 *
 * 3. Text-only fallback — when no primary checkpoint exists, reconstruct
 *    plain-text turns from llm.response events (ScriptedReasoner path or
 *    first turn before any checkpoint has been written).
 */
export function turnsToMessages(turns: Turn[]): Message[] {
	const now = Date.now();

	let baseHistory: Message[] | undefined;
	let baseFoundAt = -1;
	outer: for (let i = turns.length - 1; i >= 0; i--) {
		for (let j = turns[i].events.length - 1; j >= 0; j--) {
			const e = turns[i].events[j];
			const isDialogMessage = e.bus === "command" && e.type === "llm.response";
			const isCheckpoint = e.type === "llm.checkpoint"; // internal bus, written by onCheckpoint
			if (!isDialogMessage && !isCheckpoint) continue;
			const hist = e.payload.conversationHistory;
			if (Array.isArray(hist) && hist.length > 0) {
				baseHistory = hist as Message[];
				baseFoundAt = i;
				break outer;
			}
		}
	}

	const abortedFrom = baseFoundAt + 1; // 0 when no base found → scans all turns
	const abortedMessages: Message[] = [];
	for (let i = abortedFrom; i < turns.length; i++) {
		const turn = turns[i];
		if (turn.events.some((e) => e.type === "llm.response")) continue;
		const motorTools = turn.events.filter((e) => e.bus === "command");
		if (motorTools.length === 0) continue;
		const lines = motorTools.map((e) => {
			const { toolCallId: _tc, content: _c, ...args } = e.payload;
			const argStr = Object.entries(args)
				.map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
				.join(", ");
			return `${e.type}(${argStr})`;
		});
		abortedMessages.push({
			role: "user" as const,
			content: `[Interrupted turn — completed tool calls: ${lines.join("; ")}]`,
			timestamp: now,
		});
	}

	if (baseHistory) {
		return abortedMessages.length ? [...baseHistory, ...abortedMessages] : baseHistory;
	}

	const messages: Message[] = [];
	for (const turn of turns) {
		for (const event of turn.events) {
			if (event.type !== "llm.response") continue;
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			if (!text) continue;
			if (event.bus === "event") {
				messages.push({ role: "user", content: text, timestamp: now });
			} else if (event.bus === "command") {
				messages.push({ role: "user", content: `[assistant] ${text}`, timestamp: now });
			}
		}
	}
	return [...messages, ...abortedMessages];
}
