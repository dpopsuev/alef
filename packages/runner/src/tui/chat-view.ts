import { Box, type Component, type Container, Spacer, Text } from "@dpopsuev/alef-tui";
import type { ColorToken, ThemeTokens } from "../theme.js";
import { fmtMs, stripAnsi } from "./ansi-utils.js";
import { DynamicText } from "./dynamic-text.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { pillFooterStr, pillHeaderStr } from "./pill.js";
import { color, glyph } from "./theme.js";

const YOU_LABEL = process.env.ALEF_YOU_LABEL ?? "@you";
const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? "@alef";

function makePillHeader(label: string, fg: ColorToken): DynamicText {
	return new DynamicText((w) => color(pillHeaderStr(label, w), fg));
}

function makePillFooter(fg: ColorToken): DynamicText {
	return new DynamicText((w) => color(pillFooterStr(w), fg));
}

export function appendUserMsg(chat: Container, text: string, t: ThemeTokens): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(makePillHeader(YOU_LABEL, t.userFg));
	const box = new Box(INDENT.BLOCK, 0);
	box.addChild(new Text(color(text, t.userFg), 0, 0));
	chat.addChild(box);
	chat.addChild(makePillFooter(t.userFg));
}

/** Dim batch-timing line after the last tool call in a batch: `  ⊞ · 1.2s` */
export function appendBatchTiming(chat: Container, ms: number, t: ThemeTokens): void {
	const s = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
	chat.addChild(new Text(color(`  ⊞ · ${s}`, t.dimFg), 0, 0));
}

/**
 * Append a mutable token-usage footer. Returns the Text node so the caller
 * can call setText() when the usage event arrives.
 */
export function appendTokenFooter(chat: Container): Text {
	const node = new Text("", 1, 0);
	chat.addChild(node);
	return node;
}

export function appendNotice(chat: Container, text: string, t: ThemeTokens): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(makePillHeader("─", t.dimFg));
	chat.addChild(new Text(color(text, t.dimFg), INDENT.BLOCK, 0));
	chat.addChild(makePillFooter(t.dimFg));
}

/**
 * Append a completed tool call pill.
 *
 * Header: ╭─ ✓ shell.exec  ls  1.2s ──────╮
 * Body:   output content (if any)
 * Footer: ╰────────────────────────────────╯
 */
export function appendCompletedToolBlock(
	parent: { addChild(c: Component): void } | { addContent(c: Component): void },
	name: string,
	keyArg: string,
	elapsedMs: number,
	ok: boolean,
	outputComponent: Component | null,
	t: ThemeTokens,
): void {
	const elapsed = fmtMs(elapsedMs);
	const g = ok ? glyph("state:done") : glyph("state:error");
	const gFg = ok ? t.toolOkFg : t.toolErrFg;
	const add = (c: Component): void => {
		if ("addChild" in parent) parent.addChild(c);
		else parent.addContent(c);
	};
	add(
		new DynamicText((w) => {
			const label = `${color(g, gFg)} ${color(name, t.toolNameFg)}${keyArg ? `  ${color(keyArg, t.toolArgFg)}` : ""}  ${color(elapsed, t.timeFg)}`;
			const fill = Math.max(0, w - stripAnsi(label).length - 5);
			return `${color("╭─", t.dimFg)} ${label} ${color(`${"─".repeat(fill)}╮`, t.dimFg)}`;
		}),
	);
	if (outputComponent) {
		const box = new Box(INDENT.BLOCK, 0);
		box.addChild(outputComponent);
		add(box);
		add(makePillFooter(t.dimFg));
	}
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
		this.chat.addChild(makePillHeader(AGENT_LABEL, agentFg));
		this.contentBox = new Box(INDENT.BLOCK, 0);
		this.chat.addChild(this.contentBox);
	}

	end(): void {
		if (!this.open) return;
		this.open = false;
		this.chat.addChild(makePillFooter(this.t.agentFg));
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
