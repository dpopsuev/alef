/**
 * MarkdownTheme factories for reply text and tool output.
 *
 * Kept here so theme.ts owns color tokens and tui-mode.ts owns layout;
 * neither needs to know the other's Markdown rendering details.
 */

import type { MarkdownTheme } from "@dpopsuev/alef-tui";
import chalk from "chalk";
import { bold, color, dim, getTheme, italic } from "./theme.js";

/** Raw ANSI — never chalk, so these work regardless of chalk's TTY detection. */
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

/** Theme for the streaming reply block. Colors sourced from active theme tokens. */
export function makeMarkdownTheme(): MarkdownTheme {
	const t = getTheme();
	return {
		heading: (s) => bold(s),
		link: (s) => color(s, t.toolNameFg),
		linkUrl: (s) => dim(s),
		code: (s) => color(s, t.accentFg),
		codeBlock: (s) => s,
		codeBlockBorder: (s) => dim(s),
		quote: (s) => dim(s),
		quoteBorder: (s) => dim(s),
		hr: (s) => dim(s),
		listBullet: (s) => color(s, t.accentFg),
		bold: (s) => bold(s),
		italic: (s) => italic(s),
		strikethrough: (s) => s,
		underline: (s) => chalk.underline(s),
	};
}

/** Theme for tool output display blocks (text/plain).
 * All text dim except **bold** spans (e.g. file paths). Raw ANSI throughout. */
export function makeToolOutputMarkdownTheme(): MarkdownTheme {
	return {
		heading: (s) => `${ANSI_BOLD}${s}${ANSI_RESET}`,
		link: (s) => s,
		linkUrl: (s) => `${ANSI_DIM}${s}${ANSI_RESET}`,
		code: (s) => s,
		codeBlock: (s) => s,
		codeBlockBorder: (s) => `${ANSI_DIM}${s}${ANSI_RESET}`,
		quote: (s) => `${ANSI_DIM}${s}${ANSI_RESET}`,
		quoteBorder: (s) => `${ANSI_DIM}${s}${ANSI_RESET}`,
		hr: (s) => `${ANSI_DIM}${s}${ANSI_RESET}`,
		listBullet: (s) => s,
		bold: (s) => `${ANSI_BOLD}${s}\x1b[22m`,
		italic: (s) => `\x1b[3m${s}\x1b[23m`,
		strikethrough: (s) => s,
		underline: (s) => s,
	};
}
