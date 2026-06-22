/**
 * MarkdownTheme factories for reply text and tool output.
 *
 * Kept here so theme.ts owns color tokens and tui-mode.ts owns layout;
 * neither needs to know the other's Markdown rendering details.
 */

import type { MarkdownTheme, ThemeTokens } from "@dpopsuev/alef-tui";
import chalk from "chalk";
import { bold, color, dim, italic } from "./theme.js";

export function makeMarkdownTheme(t: ThemeTokens): MarkdownTheme {
	return {
		heading: (s) => bold(s),
		link: (s) => color(s, t.primaryFg),
		linkUrl: (s) => color(s, t.mutedFg),
		code: (s) => color(s, t.accentFg),
		codeBlock: (s) => dim(s),
		codeBlockBorder: (s) => color(s, t.mutedFg),
		quote: (s) => color(s, t.mutedFg),
		quoteBorder: (s) => color(s, t.mutedFg),
		hr: (s) => color(s, t.mutedFg),
		listBullet: (s) => color(s, t.accentFg),
		bold: (s) => bold(s),
		italic: (s) => italic(s),
		strikethrough: (s) => s,
		underline: (s) => chalk.underline(s),
	};
}

export function makeThinkingMarkdownTheme(t: ThemeTokens): MarkdownTheme {
	const wrap = (s: string): string => color(s, t.secondaryFg);
	return {
		heading: (s) => wrap(bold(s)),
		link: (s) => wrap(s),
		linkUrl: (s) => wrap(s),
		code: (s) => wrap(s),
		codeBlock: (s) => wrap(s),
		codeBlockBorder: (s) => wrap(s),
		quote: (s) => wrap(s),
		quoteBorder: (s) => wrap(s),
		hr: (s) => wrap(s),
		listBullet: (s) => wrap(s),
		bold: (s) => wrap(bold(s)),
		italic: (s) => wrap(italic(s)),
		strikethrough: (s) => wrap(s),
		underline: (s) => wrap(s),
	};
}

export function makeToolOutputMarkdownTheme(t: ThemeTokens): MarkdownTheme {
	return {
		heading: (s) => bold(s),
		link: (s) => color(s, t.mutedFg),
		linkUrl: (s) => dim(s),
		code: (s) => color(s, t.secondaryFg),
		codeBlock: (s) => s,
		codeBlockBorder: (s) => dim(s),
		quote: (s) => dim(s),
		quoteBorder: (s) => dim(s),
		hr: (s) => dim(s),
		listBullet: (s) => color(s, t.secondaryFg),
		bold: (s) => bold(s),
		italic: (s) => italic(s),
		strikethrough: (s) => s,
		underline: (s) => s,
	};
}
