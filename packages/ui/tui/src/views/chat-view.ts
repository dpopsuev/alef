import type { Component } from "../component.js";
import { Markdown } from "../components/markdown.js";
import { Pad } from "../components/pad.js";
import { Spacer } from "../components/spacer.js";
import { Text } from "../components/text.js";
import type { ThemeTokens } from "../theme-types.js";
import type { Container } from "../tui.js";
import { fmtMs } from "./ansi-utils.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";
import { bold, color, glyph } from "./theme.js";
import {
	formatToolArgs,
	largeTextArgPreview,
	stripMarkdownFenceLines,
	truncateToolOutput,
} from "./tool-view.js";

/**
 *
 */
export function appendUserMsg(
	chat: Container,
	text: string,
	t: ThemeTokens,
	label = process.env.ALEF_YOU_LABEL ?? "@you",
): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	// Identity color on the speaker label only — body stays default FG (same as AgentBlock).
	chat.addChild(new Text(bold(color(` ${label}`, t.userFg)), 0, 0));
	const pad = new Pad(INDENT.BLOCK, 0);
	pad.addChild(new Text(text, 0, 0));
	chat.addChild(pad);
}

/**
 *
 */
export function appendBatchTiming(chat: Container, ms: number, t: ThemeTokens): void {
	const indent = " ".repeat(INDENT.BLOCK);
	chat.addChild(new Text(color(`${indent}${glyph("state:batch")} · ${fmtMs(ms)}`, t.mutedFg), 0, 0));
}

/**
 *
 */
export function appendTokenFooter(chat: Container): Text {
	const node = new Text("", 1, 0);
	chat.addChild(node);
	return node;
}

/**
 *
 */
export function appendNotice(chat: Container, text: string, t: ThemeTokens): void {
	chat.addChild(new Spacer(SPACING.BETWEEN_BLOCKS));
	chat.addChild(new Text(color(text, t.mutedFg), INDENT.BLOCK, 0));
}

/**
 *
 */
export function appendCompletedToolBlock(
	parent: { addChild(c: Component): void } | { addContent(c: Component): void },
	name: string,
	keyArg: string,
	args: Record<string, unknown>,
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
	// Format as: namespace.command(param: value, ...)
	// Fall back to keyArg when args is empty (e.g., session history replay)
	const argsStr = Object.keys(args).length > 0 ? formatToolArgs(args) : (keyArg ? ` ${keyArg}` : "");
	const indent = " ".repeat(INDENT.TOOL_LINE);
	const commandStr = ok ? name + argsStr : bold(name + argsStr);
	const label = `${indent}${color(g, gFg)} ${color(commandStr, ok ? t.primaryFg : t.errFg)}  ${color(elapsed, t.mutedFg)}`;
	add(new Text(label, 0, 0));
	const preview = largeTextArgPreview(args);
	if (preview) {
		add(new Text(color(preview.header, t.mutedFg), INDENT.TOOL_OUTPUT, 0));
		const body = truncateToolOutput(stripMarkdownFenceLines(preview.body));
		const md = preview.lang ? `\`\`\`${preview.lang}\n${body}\n\`\`\`` : body;
		add(new Markdown(md, INDENT.TOOL_OUTPUT, 0, makeToolOutputMarkdownTheme(t)));
	}
	if (outputComponent) {
		// Output components already carry TOOL_OUTPUT padding — do not wrap in Pad(BLOCK).
		add(outputComponent);
	}
}

/**
 *
 */
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
