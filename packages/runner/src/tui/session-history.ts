/**
 * Session history eager load — prepends prior turns into the chat view.
 *
 * Called once during layout construction when resuming a session.
 * Reads the last `maxTurns` turns from the session store and renders
 * them as chat components at the top of the chat Container.
 *
 * The "lazy" part (appending more as the user scrolls up) is a future
 * enhancement once Container gains scroll-position detection.
 */

import type { ISessionStore } from "@dpopsuev/alef-session";
import type { ChatWriter } from "./chat-writer.js";

export interface SessionHistoryOptions {
	/** Maximum number of prior turns to load eagerly. Default: 5. */
	maxTurns?: number;
}

interface TurnPair {
	userText: string;
	agentText: string;
}

/**
 * Read last N turn pairs (llm.input + llm.response) from the store's event cache.
 * Pairs events by correlationId: user message from sense/llm.input,
 * agent reply from motor/llm.response.
 */
async function readRecentTurns(store: ISessionStore, maxTurns: number): Promise<TurnPair[]> {
	// Access the session's events via organHistory on "llm" prefix — but llm events
	// are on sense/motor buses not organ-prefixed. Use turns() instead which groups
	// by correlationId and includes llm.input + llm.response events.
	const turns = await store.turns();
	const recent = turns.slice(-maxTurns);

	const pairs: TurnPair[] = [];

	for (const turn of recent) {
		let userText: string | undefined;
		let agentText: string | undefined;

		for (const event of turn.events) {
			if (event.bus === "sense" && event.type === "llm.input") {
				const t = (event.payload as { text?: string }).text;
				if (t) userText = t;
			}
			if (event.bus === "motor" && event.type === "llm.response") {
				const t = (event.payload as { text?: string }).text;
				if (t) agentText = t;
			}
		}

		if (userText && agentText) {
			pairs.push({ userText, agentText });
		}
	}

	return pairs;
}

/**
 * Prepend session history into the chat view.
 *
 * Reads the last `maxTurns` completed turns from the store and prepends
 * them as chat pill components. Adds a divider notice above the history
 * to distinguish prior context from the current session.
 *
 * Only writes to the chat Container if there is history to show.
 */
export async function prependSessionHistory(
	store: ISessionStore,
	writer: ChatWriter,
	opts: SessionHistoryOptions = {},
): Promise<void> {
	const maxTurns = opts.maxTurns ?? 5;
	const pairs = await readRecentTurns(store, maxTurns);

	if (pairs.length === 0) return;

	// Prepend in order (oldest first) — insertAt(0) each time would reverse,
	// so render to a temp array and insertAt(0) the whole block.
	const totalBefore = writer.container.children.length;

	// Add a "resumed context" divider first (appears at top after all prepends).
	writer.addNotice(`Resumed — ${pairs.length} prior turn${pairs.length === 1 ? "" : "s"} loaded`);

	// Add turns in chronological order.
	for (const pair of pairs) {
		writer.addUserMessage(pair.userText);
		writer.addAgentReply(pair.agentText);
	}

	// Move the newly added children (from totalBefore onward) to the top.
	const newChildren = writer.container.children.splice(totalBefore);
	for (let i = newChildren.length - 1; i >= 0; i--) {
		const child = newChildren[i];
		if (child) writer.container.insertAt(0, child);
	}
}
