/**
 * Render display blocks through ChatLog — same host path as in-session history.
 */

import type { DisplayBlock } from "@dpopsuev/alef-session/context";
import type { ThemeTokens } from "../theme-types.js";
import { Container } from "../tui.js";
import { ChatLog, type ChatLogLabels } from "./chat-log.js";
import { appendDisplayBlocks } from "./session-history.js";

/**
 * Host projector blocks on ChatLog and return rendered terminal lines.
 */
export function renderDisplayBlocksToLines(
	blocks: readonly DisplayBlock[],
	width: number,
	theme: ThemeTokens,
	labels?: ChatLogLabels,
): string[] {
	if (blocks.length === 0) return ["  (empty session)"];
	const container = new Container();
	const writer = new ChatLog(container, theme, labels);
	appendDisplayBlocks(writer, blocks);
	return container.render(Math.max(1, width));
}
