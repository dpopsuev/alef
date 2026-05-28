import { Box, type Component, type Container, Spacer, Text } from "@dpopsuev/alef-tui";
import type { ColorToken, ThemeTokens } from "../theme.js";
import { DynamicText } from "./dynamic-text.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { pillFooterStr, pillHeaderStr } from "./pill.js";
import { bg, color } from "./theme.js";

const YOU_LABEL = process.env.ALEF_YOU_LABEL ?? "@you";
const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? "@alef";

type BgFn = ((s: string) => string) | null;

function makePillHeader(label: string, fg: ColorToken, bgFn: BgFn): DynamicText {
	if (bgFn) return new DynamicText((w) => bgFn(color(pillHeaderStr(label, w), fg)));
	return new DynamicText((w) => color(pillHeaderStr(label, w), fg));
}

function makePillFooter(fg: ColorToken, bgFn: BgFn): DynamicText {
	if (bgFn) return new DynamicText((w) => bgFn(color(pillFooterStr(w), fg)));
	return new DynamicText((w) => color(pillFooterStr(w), fg));
}

export function appendUserMsg(chat: Container, text: string, t: ThemeTokens): void {
	const bgFn: BgFn = (s) => bg(s, t.userBg);
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(makePillHeader(YOU_LABEL, t.userFg, bgFn));
	const box = new Box(INDENT.BLOCK, 0, bgFn);
	box.addChild(new Text(color(text, t.userFg), 0, 0));
	chat.addChild(box);
	chat.addChild(makePillFooter(t.userFg, bgFn));
}

export function appendNotice(chat: Container, text: string, t: ThemeTokens): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(makePillHeader("─", t.dimFg, null));
	chat.addChild(new Text(color(text, t.dimFg), INDENT.BLOCK, 0));
	chat.addChild(makePillFooter(t.dimFg, null));
}

/**
 * Incremental agent pill — header added in start(), footer added in end().
 * Content routed through addContent() between the two calls.
 * No background fill — agent replies are text-only, no fill.
 */
export class AgentBlock {
	private open = false;
	private contentBox: Box | null = null;

	constructor(
		private readonly chat: Container,
		private readonly t: ThemeTokens,
	) {}

	start(): void {
		if (this.open) return;
		this.open = true;
		const { agentFg } = this.t;
		this.chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
		this.chat.addChild(makePillHeader(AGENT_LABEL, agentFg, null));
		this.contentBox = new Box(INDENT.BLOCK, 0);
		this.chat.addChild(this.contentBox);
	}

	end(): void {
		if (!this.open) return;
		this.open = false;
		this.chat.addChild(makePillFooter(this.t.agentFg, null));
		this.contentBox = null;
	}

	addContent(component: Component): void {
		(this.contentBox ?? this.chat).addChild(component);
	}

	removeContent(component: Component): void {
		(this.contentBox ?? this.chat).removeChild(component);
	}

	get isOpen(): boolean {
		return this.open;
	}

	reset(): void {
		this.open = false;
		this.contentBox = null;
	}
}
