/**
 * SessionGuard — enforces a per-session turn limit around dialog.send().
 *
 * Extracted from DialogOrgan (TSK-466). Turn counting is a session policy,
 * not a message boundary concern. DialogOrgan is a pure gateway.
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";

export class SessionGuard {
	private turnCount = 0;

	constructor(
		private readonly dialog: DialogOrgan,
		private readonly maxTurns: number,
	) {}

	send(text: string, sender = "human", timeoutMs?: number): Promise<string> {
		if (this.maxTurns > 0 && this.turnCount >= this.maxTurns) {
			return Promise.reject(new Error(`Max turns reached (${this.maxTurns}). Start a new session to continue.`));
		}
		this.turnCount++;
		return timeoutMs !== undefined ? this.dialog.send(text, sender, timeoutMs) : this.dialog.send(text, sender);
	}
}
