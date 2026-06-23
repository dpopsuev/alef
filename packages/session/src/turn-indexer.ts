import { createHash } from "node:crypto";
import type { StorageRecord, Turn } from "./session-store.js";
import { eventTypeWeight, extractContentLength } from "./session-store.js";

export function cwdHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

export class TurnIndexer {
	readonly turnMap = new Map<string, Turn>();
	readonly hitCountsMap = new Map<string, number>();
	private _nextTurnIndex = 0;
	private readonly _turnContentLengths = new Map<string, number>();

	index(record: StorageRecord): void {
		if (record.bus === "internal" && record.type === "window.assembled") {
			const ids = (record.payload as { includedTurnIds?: string[] }).includedTurnIds ?? [];
			for (const id of ids) {
				this.hitCountsMap.set(id, (this.hitCountsMap.get(id) ?? 0) + 1);
			}
			return;
		}
		if (record.bus !== "command" && record.bus !== "event" && record.type !== "llm.checkpoint") return;

		const turnId = record.correlationId;
		let turn = this.turnMap.get(turnId);
		if (!turn) {
			turn = { id: turnId, events: [], turnIndex: this._nextTurnIndex++, tokenCost: 0, typeWeight: 0 };
			this.turnMap.set(turnId, turn);
			this._turnContentLengths.set(turnId, 0);
		}
		turn.events.push(record);
		turn.typeWeight = Math.max(turn.typeWeight, eventTypeWeight(record.type));
		const sum = (this._turnContentLengths.get(turnId) ?? 0) + extractContentLength(record.payload);
		this._turnContentLengths.set(turnId, sum);
		turn.tokenCost = Math.ceil(sum / 4);
	}

	get nextTurnIndex(): number {
		return this._nextTurnIndex;
	}
}
