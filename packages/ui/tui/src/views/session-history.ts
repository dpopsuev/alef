/**
 * Session history eager load — prepends prior turns into the chat view via the shared projector.
 *
 * Called once during layout construction when resuming a session.
 */

import type { SessionStore } from "@dpopsuev/alef-session/storage";
import {
	type DisplayBlock,
	loadPlanPreview,
	projectSessionRecords,
	type SessionRecordProjection,
} from "@dpopsuev/alef-session/context";
import type { ChatLog } from "./chat-log.js";

const DEFAULT_MAX_TURNS = 5;
const EVENTS_PER_TURN_ESTIMATE = 8;
const MIN_EVENT_WINDOW = 40;

/**
 *
 */
export interface SessionHistoryOptions {
	/** Maximum number of prior dialog turns to prefer. Default: 5. */
	maxTurns?: number;
	/** Project cwd for plan.json sidecar. */
	cwd?: string;
}

/**
 * Map projected display blocks onto ChatLog write APIs.
 */
export function appendDisplayBlocks(writer: ChatLog, blocks: readonly DisplayBlock[]): void {
	for (const block of blocks) {
		switch (block.kind) {
			case "plan": {
				const steps = block.lines.length > 0 ? `\n  ${block.lines.join("\n  ")}` : "";
				writer.addNotice(`◆ plan [${block.phase}] ${block.desired}${steps}`);
				break;
			}
			case "user":
				writer.addUserMessage(block.text);
				break;
			case "assistant":
				writer.addAgentReply(block.text);
				break;
			case "tool":
				writer.addCompletedToolBlock(block.name, block.summary ?? "", 0, true, null, null);
				break;
			case "state":
				writer.addNotice(`▨ ${block.label}: ${block.text}`);
				break;
		}
	}
}

/**
 * Prepend session history into the chat view using the shared transcript projector.
 */
export async function prependSessionHistory(
	store: SessionStore,
	writer: ChatLog,
	opts: SessionHistoryOptions = {},
): Promise<void> {
	const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
	const events = await store.events();
	const windowSize = Math.max(maxTurns * EVENTS_PER_TURN_ESTIMATE, MIN_EVENT_WINDOW);
	const recent = events.slice(-windowSize);
	const records: SessionRecordProjection[] = recent.map((event) => ({
		bus: event.bus,
		type: event.type,
		payload: event.payload,
	}));

	const plan = await loadPlanPreview(opts.cwd);
	const blocks = projectSessionRecords(records, plan ? { plan } : undefined);
	if (blocks.length === 0) return;

	const dialogBlocks = blocks.filter((block) => block.kind === "user" || block.kind === "assistant");
	const userCount = dialogBlocks.filter((block) => block.kind === "user").length;
	const turnCount = Math.min(maxTurns, Math.max(1, userCount));

	const planBlocks = blocks.filter((block) => block.kind === "plan" || block.kind === "state");
	const transcript = blocks.filter((block) => block.kind !== "plan" && block.kind !== "state");

	// Keep last N user turns worth of transcript (tools between them included).
	let usersSeen = 0;
	const kept: DisplayBlock[] = [];
	for (let i = transcript.length - 1; i >= 0; i--) {
		const block = transcript[i]!;
		kept.push(block);
		if (block.kind === "user") {
			usersSeen++;
			if (usersSeen >= turnCount) break;
		}
	}
	kept.reverse();

	const totalBefore = writer.container.children.length;
	writer.addNotice(`Resumed — ${turnCount} prior turn${turnCount === 1 ? "" : "s"} loaded`);
	appendDisplayBlocks(writer, [...planBlocks, ...kept]);

	const newChildren = writer.container.children.splice(totalBefore);
	for (let i = newChildren.length - 1; i >= 0; i--) {
		const child = newChildren[i]!;
		writer.container.insertAt(0, child);
	}
}
