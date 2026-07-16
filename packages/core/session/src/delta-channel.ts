/**
 * DeltaChannel - Message history delta optimization for storage.
 *
 * Instead of writing full conversationHistory arrays on every checkpoint,
 * we compute deltas (append/remove/replace) and periodically snapshot.
 *
 * Reduces storage size and write overhead for long sessions.
 */

import type { MessageDelta, MessageDeltaOp, MessageSnapshot } from "./contracts/storage.js";

const SNAPSHOT_INTERVAL = 50; // Full snapshot every N checkpoints

/**
 * Compute delta operations between two message arrays.
 */
function computeDelta(prev: readonly unknown[], next: readonly unknown[]): MessageDeltaOp[] {
	const ops: MessageDeltaOp[] = [];

	// Simple strategy: find common prefix, then append/remove/replace from there
	let commonPrefixLen = 0;
	while (
		commonPrefixLen < prev.length &&
		commonPrefixLen < next.length &&
		prev[commonPrefixLen] === next[commonPrefixLen]
	) {
		commonPrefixLen++;
	}

	// Remove messages beyond common prefix
	for (let i = prev.length - 1; i >= commonPrefixLen; i--) {
		ops.push({ type: "remove", index: i });
	}

	// Append new messages
	for (let i = commonPrefixLen; i < next.length; i++) {
		ops.push({ type: "append", message: next[i] });
	}

	return ops;
}

/**
 * Apply delta operations to reconstruct message array.
 */
export function applyDelta(base: unknown[], ops: MessageDeltaOp[]): unknown[] {
	const result = base.slice();
	for (const op of ops) {
		switch (op.type) {
			case "append":
				result.push(op.message);
				break;
			case "remove":
				if (op.index >= 0 && op.index < result.length) {
					result.splice(op.index, 1);
				}
				break;
			case "replace":
				if (op.index >= 0 && op.index < result.length) {
					result[op.index] = op.message;
				}
				break;
		}
	}
	return result;
}

/**
 * Delta channel state tracker.
 */
export class DeltaChannel {
	private _lastMessages: unknown[] = [];
	private _sequence = 0;
	private _checkpointsSinceSnapshot = 0;

	/**
	 * Process a checkpoint and return either a delta or a snapshot.
	 * @returns MessageDelta | MessageSnapshot | null (null when no change)
	 */
	processCheckpoint(messages: unknown[]): MessageDelta | MessageSnapshot | null {
		this._sequence++;
		this._checkpointsSinceSnapshot++;

		const ops = computeDelta(this._lastMessages, messages);

		// No changes - skip
		if (ops.length === 0) {
			return null;
		}

		// Time for snapshot?
		if (this._checkpointsSinceSnapshot >= SNAPSHOT_INTERVAL) {
			this._checkpointsSinceSnapshot = 0;
			this._lastMessages = messages.slice();
			return {
				sequence: this._sequence,
				messages: messages.slice(),
				timestamp: Date.now(),
			};
		}

		// Emit delta
		this._lastMessages = messages.slice();
		return {
			sequence: this._sequence,
			operations: ops,
			timestamp: Date.now(),
		};
	}

	/**
	 * Reset state (e.g., when loading from storage).
	 * Calculates checkpointsSinceSnapshot to maintain snapshot interval alignment.
	 */
	reset(messages: unknown[], sequence: number): void {
		this._lastMessages = messages.slice();
		this._sequence = sequence;
		// Calculate how many checkpoints since last snapshot to maintain 50-checkpoint interval
		this._checkpointsSinceSnapshot = sequence % SNAPSHOT_INTERVAL;
	}
}

/**
 * Reconstruct full message history from snapshots + deltas.
 */
export function reconstructHistory(
	snapshots: MessageSnapshot[],
	deltas: MessageDelta[],
): unknown[] {
	if (snapshots.length === 0 && deltas.length === 0) return [];

	// Find latest snapshot
	const latestSnapshot = snapshots.sort((a, b) => b.sequence - a.sequence)[0];
	let messages = latestSnapshot ? latestSnapshot.messages.slice() : [];
	const snapshotSeq = latestSnapshot?.sequence ?? 0;

	// Apply all deltas after the snapshot
	const relevantDeltas = deltas
		.filter((d) => d.sequence > snapshotSeq)
		.sort((a, b) => a.sequence - b.sequence);

	for (const delta of relevantDeltas) {
		messages = applyDelta(messages, delta.operations);
	}

	return messages;
}
