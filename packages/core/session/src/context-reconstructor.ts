import type { StorageRecord, Turn } from "./session-store.js";
import { TurnIndexer } from "./turn-indexer.js";

export interface TurnSnapshot {
	turn: number;
	correlationId: string;
	messageCount: number;
	messageRoles: string[];
	toolNames: string[];
	promotedNamespaces: string[];
	catalogState: "injected" | "present" | "evicted" | "none";
	includedTurnIds: string[];
	budgetUsed: number;
	budgetTotal: number;
	hasSystemPrompt: boolean;
	conversationHistory: unknown[] | undefined;
}

export interface SessionIndex {
	turns: Turn[];
	hitCounts: ReadonlyMap<string, number>;
	turnByNumber: ReadonlyMap<number, Turn>;
	promotionLog: ReadonlyMap<number, Set<string>>;
	windowAssemblies: ReadonlyMap<number, { includedTurnIds: string[]; budgetUsed: number; budgetTotal: number }>;
}

export function buildSessionIndex(records: StorageRecord[]): SessionIndex {
	const indexer = new TurnIndexer();
	for (const r of records) indexer.index(r);

	const turns = Array.from(indexer.turnMap.values()).sort((a, b) => a.turnIndex - b.turnIndex);
	const turnByNumber = new Map<number, Turn>();
	for (const t of turns) turnByNumber.set(t.turnIndex, t);

	const promotedNamespaces = new Set<string>();
	const promotionLog = new Map<number, Set<string>>();

	const windowAssemblies = new Map<number, { includedTurnIds: string[]; budgetUsed: number; budgetTotal: number }>();
	let assemblyIndex = 0;

	for (const r of records) {
		if (r.bus === "command" && r.type.startsWith("tools.describe")) {
			const ns = namespaceOf(r.type);
			if (ns) promotedNamespaces.add(ns);
		}

		if (r.bus === "notification" && r.type === "llm.result") {
			const p = r.payload as { toolCalls?: Array<{ name: string }>; turn?: number };
			if (p.toolCalls) {
				for (const tc of p.toolCalls) promotedNamespaces.add(namespaceOf(tc.name));
			}
			if (p.turn !== undefined) {
				promotionLog.set(p.turn, new Set(promotedNamespaces));
			}
		}

		if (r.bus === "internal" && r.type === "window.assembled") {
			const p = r.payload as { includedTurnIds?: string[]; budgetUsed?: number; budgetTotal?: number };
			windowAssemblies.set(assemblyIndex++, {
				includedTurnIds: p.includedTurnIds ?? [],
				budgetUsed: p.budgetUsed ?? 0,
				budgetTotal: p.budgetTotal ?? 0,
			});
		}
	}

	return {
		turns,
		hitCounts: indexer.hitCountsMap,
		turnByNumber,
		promotionLog,
		windowAssemblies,
	};
}

export function reconstructTurn(index: SessionIndex, turnNumber: number, evictAfterTurn = 3): TurnSnapshot | undefined {
	const turn = index.turnByNumber.get(turnNumber);
	if (!turn) return undefined;

	const promoted = index.promotionLog.get(turnNumber) ?? new Set<string>();

	const assembly = index.windowAssemblies.get(turnNumber);
	const includedTurnIds = assembly?.includedTurnIds ?? [];
	const budgetUsed = assembly?.budgetUsed ?? 0;
	const budgetTotal = assembly?.budgetTotal ?? 0;

	let catalogState: TurnSnapshot["catalogState"] = "none";
	if (turnNumber === 0) catalogState = "injected";
	else if (turnNumber > 0 && turnNumber <= evictAfterTurn) catalogState = "present";
	else if (turnNumber > evictAfterTurn) catalogState = "evicted";

	const toolNames: string[] = [];
	let hasSystemPrompt = false;
	let conversationHistory: unknown[] | undefined;

	for (const event of turn.events) {
		if (event.bus === "command" && event.type !== "llm.response") {
			const name = event.type;
			if (!toolNames.includes(name)) toolNames.push(name);
		}
		if (event.bus === "notification" && event.type === "llm.result") {
			const p = event.payload as { toolCalls?: Array<{ name: string }> };
			if (p.toolCalls) {
				for (const tc of p.toolCalls) {
					if (!toolNames.includes(tc.name)) toolNames.push(tc.name);
				}
			}
		}
		if (event.bus === "command" && event.type === "llm.response") {
			const p = event.payload as { conversationHistory?: unknown[] };
			conversationHistory = p.conversationHistory;
		}
	}

	const messageRoles: string[] = [];
	let messageCount = 0;
	if (conversationHistory) {
		for (const msg of conversationHistory) {
			const role = (msg as { role?: string }).role ?? "unknown";
			messageRoles.push(role);
			messageCount++;
		}
		hasSystemPrompt = messageRoles.includes("system");
	}

	return {
		turn: turnNumber,
		correlationId: turn.id,
		messageCount,
		messageRoles,
		toolNames,
		promotedNamespaces: [...promoted],
		catalogState,
		includedTurnIds,
		budgetUsed,
		budgetTotal,
		hasSystemPrompt,
		conversationHistory,
	};
}

export function reconstructAllTurns(records: StorageRecord[], evictAfterTurn = 3): TurnSnapshot[] {
	const index = buildSessionIndex(records);
	const snapshots: TurnSnapshot[] = [];
	for (let i = 0; i < index.turns.length; i++) {
		const snapshot = reconstructTurn(index, i, evictAfterTurn);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

function namespaceOf(name: string): string {
	return name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
}
