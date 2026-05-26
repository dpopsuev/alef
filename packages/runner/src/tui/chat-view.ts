/**
 * Chat block components — UserBlock, AgentBlock, NoticeBlock.
 *
 * Each is a factory that appends a fully self-contained visual block
 * into a parent Container. No state held here; blocks are append-only.
 */

import { Box, type Component, type Container, Spacer, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { DynamicText } from "./dynamic-text.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { pillFooterStr, pillHeaderStr } from "./pill.js";
import { bg, color, dim } from "./theme.js";

const YOU_LABEL = process.env.ALEF_YOU_LABEL ?? "@you";
const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? "@alef";

/**
 * Append a @you message block with pill borders and background.
 *
 * ╭─ @you ──────────────────╮  ← userBg
 *   Hello                      ← userBg
 * ╰─────────────────────────╯  ← userBg
 */
export function appendUserMsg(chat: Container, text: string, t: ThemeTokens): void {
	const bgFn = (s: string): string => bg(s, t.userBg);
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(new DynamicText((w) => bgFn(color(pillHeaderStr(YOU_LABEL, w), t.userFg))));
	const box = new Box(INDENT.BLOCK, 0, bgFn);
	box.addChild(new Text(color(text, t.userFg), 0, 0));
	chat.addChild(box);
	chat.addChild(new DynamicText((w) => bgFn(color(pillFooterStr(w), t.userFg))));
}

/**
 * Append a notice/system block with dim pill borders and no background.
 *
 * ╭─ ─ ─────────────────────╮
 *   (interrupted)
 * ╰─────────────────────────╯
 */
export function appendNotice(chat: Container, text: string, t: ThemeTokens): void {
	const colorFn = (s: string): string => dim(color(s, t.dimFg));
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(new DynamicText((w) => colorFn(pillHeaderStr("─", w))));
	chat.addChild(new Text(dim(text), INDENT.BLOCK, 0));
	chat.addChild(new DynamicText((w) => colorFn(pillFooterStr(w))));
}

/**
 * Agent block — pill header + optional background Box + pill footer.
 *
 * Open at first tool call or first text chunk; close at turn end or abort.
 * All turn content (tool lines, streaming segments, token footer) is
 * routed into the inner Box via addContent() so it shares the background.
 */
export class AgentBlock {
	private open = false;
	private contentBox: Box | null = null;
	/** Saved during start() for use by end(). Null outside an open block. */
	private savedBgFn: ((s: string) => string) | null = null;

	constructor(
		private readonly chat: Container,
		private readonly t: ThemeTokens,
	) {}

	/** Open the block. No-op if already open. */
	start(): void {
		if (this.open) return;
		this.open = true;
		const t = this.t;
		const hasBg = t.agentBg.truecolor || t.agentBg.ansi256 !== undefined || t.agentBg.ansi16 !== undefined;
		this.savedBgFn = hasBg ? (s: string) => bg(s, t.agentBg) : null;
		const bgFn = this.savedBgFn;

		this.chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
		this.chat.addChild(
			bgFn
				? new DynamicText((w) => bgFn(color(pillHeaderStr(AGENT_LABEL, w), t.agentFg)))
				: new DynamicText((w) => color(pillHeaderStr(AGENT_LABEL, w), t.agentFg)),
		);
		this.contentBox = bgFn ? new Box(INDENT.BLOCK, 0, bgFn) : new Box(INDENT.BLOCK, 0);
		this.chat.addChild(this.contentBox);
	}

	/** Close the block, adding the pill footer. No-op if not open. */
	end(): void {
		if (!this.open) return;
		this.open = false;
		const t = this.t;
		const bgFn = this.savedBgFn;
		this.chat.addChild(
			bgFn
				? new DynamicText((w) => bgFn(color(pillFooterStr(w), t.agentFg)))
				: new DynamicText((w) => color(pillFooterStr(w), t.agentFg)),
		);
		this.contentBox = null;
		this.savedBgFn = null;
	}

	/** Route a component into the inner Box (or direct to chat if not open). */
	addContent(component: Component): void {
		(this.contentBox ?? this.chat).addChild(component);
	}

	/** Remove a component from the inner Box (or from chat if not open). */
	removeContent(component: Component): void {
		(this.contentBox ?? this.chat).removeChild(component);
	}

	get isOpen(): boolean {
		return this.open;
	}

	/** Reset open state without emitting a footer (new turn started). */
	reset(): void {
		this.open = false;
		this.contentBox = null;
		this.savedBgFn = null;
	}
}
