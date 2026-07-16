/**
 * Session history eager load — prepends prior turns into the chat view via the shared projector.
 *
 * Called once during layout construction when resuming a session.
 */

import type { SessionStore } from "@dpopsuev/alef-session/storage";
import {
	type DisplayBlock,
	loadPlanPreview,
	projectTranscriptSlice,
} from "@dpopsuev/alef-session/context";
import type { ChatLog } from "./chat-log.js";

const DEFAULT_MAX_TURNS = 5;

/**
 *
 */
export interface SessionHistoryOptions {
	/** Maximum number of prior dialog turns to prefer. Default: 5. */
	maxTurns?: number;
	/** Project cwd for multi-plan shelf preview. */
	cwd?: string;
}

/**
 * Map projected display blocks onto ChatLog write APIs.
 * Shared by resume history and session-picker preview (via renderDisplayBlocksToLines).
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
				writer.addCompletedToolBlock(block.name, block.summary ?? "", {}, 0, true, null, null);
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
	const plan = await loadPlanPreview(opts.cwd);
	const kept = projectTranscriptSlice(
		events.map((event) => ({
			bus: event.bus,
			type: event.type,
			payload: event.payload,
		})),
		maxTurns,
		plan ? { plan } : undefined,
	);
	if (kept.length === 0) return;

	const turnCount = kept.filter((block) => block.kind === "user").length;
	const totalBefore = writer.container.children.length;
	writer.addNotice(`Resumed — ${turnCount} prior turn${turnCount === 1 ? "" : "s"} loaded`);
	appendDisplayBlocks(writer, kept);

	const newChildren = writer.container.children.splice(totalBefore);
	for (let i = newChildren.length - 1; i >= 0; i--) {
		const child = newChildren[i]!;
		writer.container.insertAt(0, child);
	}
}
