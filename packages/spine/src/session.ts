/**
 * Session storage types — shared across spine, corpus, and organ packages.
 *
 * Extracted here so organs (e.g. organ-context) can depend on the SessionStore
 * interface without importing packages/runner, which would create a dependency cycle.
 *
 * The concrete SessionStore class with fs I/O lives in packages/runner/src/session-store.ts.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Storage record types
// ---------------------------------------------------------------------------

/** Discriminant for which bus a storage record originated from. */
export type BusKind = "motor" | "sense" | "internal";

export interface StorageRecord {
	/** 'motor' or 'sense' for bus events; 'internal' for control records. */
	bus: BusKind;
	/** Event type, e.g. 'fs.read', 'dialog.message', 'window.assembled'. */
	type: string;
	/** Turn group key — same for all events in one user turn. */
	correlationId: string;
	/** Payload after redaction — sensitive keys replaced with [REDACTED]. */
	payload: Record<string, unknown>;
	/** Epoch ms — set by the bus at publish time. */
	timestamp: number;
	/** Ms since the first event with this correlationId was seen. Set by the bus. */
	elapsed?: number;
	/**
	 * SHA-256 of { bus, type, correlationId, payload, timestamp } (post-redaction).
	 * Detects tampering: any modification to the record changes this field.
	 * Optional only for test-authored records; SessionLog always sets it.
	 */
	hash?: string;
}

/**
 * Compute the SHA-256 audit hash of a record's stable fields.
 * Excludes the hash field itself so the computation is deterministic.
 */
export function hashRecord(record: Omit<StorageRecord, "hash">): string {
	const stable = JSON.stringify({
		bus: record.bus,
		type: record.type,
		correlationId: record.correlationId,
		payload: record.payload,
		timestamp: record.timestamp,
	});
	return createHash("sha256").update(stable, "utf-8").digest("hex");
}

/** Special internal record emitted by TurnAssembler after each context window selection. */
export interface WindowAssembledRecord extends StorageRecord {
	bus: Extract<BusKind, "internal">;
	type: "window.assembled";
	payload: {
		includedTurnIds: string[];
		queryTokens: string[];
		budgetUsed: number;
		budgetTotal: number;
	};
}

// ---------------------------------------------------------------------------
// Turn — grouped events by correlationId
// ---------------------------------------------------------------------------

export interface Turn {
	id: string; // correlationId
	events: StorageRecord[];
	/** Ordinal position in the session (0-based). Used for recency scoring. */
	turnIndex: number;
	/** Estimated token cost: Σ(JSON.stringify(payload).length / 4) */
	tokenCost: number;
	/** Max event type weight across all events in this turn. */
	typeWeight: number;
}

// ---------------------------------------------------------------------------
// SessionStore interface — minimal public API organs depend on.
//
// The concrete class (with fs I/O, static factory methods) lives in
// packages/runner/src/session-store.ts.
// ---------------------------------------------------------------------------

export interface SessionStore {
	/** Unique 8-char hex session identifier. */
	readonly id: string;
	/** Absolute path to the JSONL session file. */
	readonly path: string;
	/** Append a raw StorageRecord to the JSONL file. */
	append(record: StorageRecord): Promise<void>;
	/** Read all stored events grouped into Turn[] by correlationId. */
	turns(): Promise<Turn[]>;
	/** Count how many times each turn was included in a past context window. */
	hitCounts(): Promise<Map<string, number>>;
}
