import type { ThemeTokens } from "@dpopsuev/alef-tui";
import { type Component, type Container, Pad, Spacer, Text } from "@dpopsuev/alef-tui";
import { fmtMs } from "./ansi-utils.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { bold, color, glyph } from "./theme.js";

export function appendUserMsg(
	chat: Container,
	text: string,
	t: ThemeTokens,
	label = process.env.ALEF_YOU_LABEL ?? "@you",
): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(new Text(bold(color(` ${label}`, t.userFg)), 0, 0));
	const pad = new Pad(INDENT.BLOCK, 0);
	pad.addChild(new Text(color(text, t.userFg), 0, 0));
	chat.addChild(pad);
}

export function appendBatchTiming(chat: Container, ms: number, t: ThemeTokens): void {
	chat.addChild(new Text(color(`  ${glyph("state:batch")} · ${fmtMs(ms)}`, t.mutedFg), 0, 0));
}

export function appendTokenFooter(chat: Container): Text {
	const node = new Text("", 1, 0);
	chat.addChild(node);
	return node;
}

export function appendNotice(chat: Container, text: string, t: ThemeTokens): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(new Text(color(text, t.mutedFg), INDENT.BLOCK, 0));
}

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
	const gFg = ok ? t.okFg : t.errFg;
	const add = (c: Component): void => {
		if ("addChild" in parent) parent.addChild(c);
		else parent.addContent(c);
	};
	const label = `  ${color(g, gFg)} ${color(name, t.primaryFg)}${keyArg ? `  ${color(keyArg, t.secondaryFg)}` : ""}  ${color(elapsed, t.mutedFg)}`;
	add(new Text(label, 0, 0));
	if (outputComponent) {
		const pad = new Pad(INDENT.BLOCK, 0);
		pad.addChild(outputComponent);
		add(pad);
	}
}

export class AgentBlock {
	private open = false;
	private contentPad: Pad | null = null;

	constructor(
		private readonly chat: Container,
		private readonly t: ThemeTokens,
		private readonly label = process.env.ALEF_AGENT_LABEL ?? "@alef",
	) {}

	start(): void {
		if (this.open) return;
		this.open = true;
		this.chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
		this.chat.addChild(new Text(bold(color(` ${this.label}`, this.t.agentFg)), 0, 0));
		this.contentPad = new Pad(INDENT.BLOCK, 0);
		this.chat.addChild(this.contentPad);
	}

	end(): void {
		if (!this.open) return;
		this.open = false;
		this.contentPad = null;
	}

	addContent(component: Component): void {
		(this.contentPad ?? this.chat).addChild(component);
	}

	removeContent(component: Component): void {
		(this.contentPad ?? this.chat).removeChild(component);
	}

	get isOpen(): boolean {
		return this.open;
	}

	reset(): void {
		this.open = false;
		this.contentPad = null;
	}
}
