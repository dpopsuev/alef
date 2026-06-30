const HASH_HEX_LENGTH = 16;

import { createHash } from "node:crypto";

export type BusKind = "command" | "event" | "notification" | "internal";

export interface StorageActor {
	address: string;
	type: "human" | "agent";
}

export interface StorageRecord {
	bus: BusKind;
	type: string;
	correlationId: string;
	payload: Record<string, unknown>;
	timestamp: number;
	elapsed?: number;
	hash?: string;
	/** The conversation ID (JsonlSessionStore.id) — the Topic this event belongs to. */
	sessionId?: string;
	/** Who produced this event. */
	actor?: StorageActor;
}

export function hashRecord(record: Omit<StorageRecord, "hash">): string {
	const data = JSON.stringify({
		bus: record.bus,
		type: record.type,
		correlationId: record.correlationId,
		payload: record.payload,
		timestamp: record.timestamp,
	});
	return createHash("sha256").update(data).digest("hex").slice(0, HASH_HEX_LENGTH);
}

export interface WindowAssembledRecord extends StorageRecord {
	bus: "internal";
	type: "window.assembled";
	payload: {
		includedTurnIds: string[];
		excludedTurnIds: string[];
		totalTurns: number;
		includedTurns: number;
		budgetUsed: number;
		budgetTotal: number;
	};
}

export interface Turn {
	id: string;
	events: StorageRecord[];
	turnIndex: number;
	tokenCost: number;
	typeWeight: number;
}

export interface SessionStore {
	readonly id: string;
	readonly path: string;
	append(record: StorageRecord): Promise<void>;
	events(): Promise<StorageRecord[]>;
	turns(): Promise<Turn[]>;
	hitCounts(): Promise<Map<string, number>>;
	adapterHistory(adapterName: string): Promise<StorageRecord[]>;
	name(): string | undefined;
	setName(name: string): Promise<void>;
}

/** @deprecated Use SessionStore (the interface) */
export type ISessionStore = SessionStore;
