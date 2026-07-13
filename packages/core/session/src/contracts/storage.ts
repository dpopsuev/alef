const HASH_HEX_LENGTH = 16;

import { createHash } from "node:crypto";

/**
 *
 */
export type BusKind = "command" | "event" | "notification" | "internal";

/**
 *
 */
export interface StorageActor {
	address: string;
	type: "human" | "agent";
}

/**
 *
 */
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

/**
 *
 */
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

/**
 *
 */
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

/**
 *
 */
export interface Turn {
	id: string;
	events: StorageRecord[];
	turnIndex: number;
	tokenCost: number;
	typeWeight: number;
}

/** Who last set the session display name — user freezes auto overwrite. */
export type SessionNameSource = "user" | "auto";

/** Who last set session tags — user freezes LLM overwrite. */
export type SessionTagsSource = "user" | "auto";

/**
 *
 */
export interface SetNameOptions {
	/** Defaults to `"user"`. Auto names no-op when a user name is already set. */
	source?: SessionNameSource;
}

/**
 *
 */
export interface SetTagsOptions {
	/** Defaults to `"user"`. Auto tags no-op when user-owned tags are set. */
	source?: SessionTagsSource;
}

/**
 *
 */
export interface SessionStore {
	readonly id: string;
	readonly path: string;
	append(record: StorageRecord): Promise<void>;
	events(): Promise<StorageRecord[]>;
	turns(): Promise<Turn[]>;
	hitCounts(): Promise<Map<string, number>>;
	adapterHistory(adapterName: string): Promise<StorageRecord[]>;
	name(): string | undefined;
	/** Provenance of the current name, if any. */
	nameSource(): SessionNameSource | undefined;
	setName(name: string, options?: SetNameOptions): Promise<void>;
	/** Session tags. Empty when unset. */
	tags(): readonly string[];
	/** Provenance of the current tags, if any. */
	tagsSource(): SessionTagsSource | undefined;
	setTags(tags: readonly string[], options?: SetTagsOptions): Promise<void>;
	/** Concatenated text used for picker/content search. */
	searchBlob(): string | undefined;
	setSearchBlob(blob: string): Promise<void>;
}
