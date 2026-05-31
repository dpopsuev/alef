/**
 * Pure ANSI formatting utilities — no theme singleton, no global state
 * except the nerd-fonts flag set once at process start.
 *
 * Extracted from theme.ts so tui/ can import these without creating a
 * backward dependency on the full theme module.
 */

import chalk from "chalk";

export type ColorDepth = "truecolor" | "256" | "16";

export interface ColorToken {
	truecolor?: string;
	ansi256?: number;
	ansi16?: number;
}

export function colorDepth(): ColorDepth {
	const ct = (process.env.COLORTERM ?? "").toLowerCase();
	if (ct === "truecolor" || ct === "24bit") return "truecolor";
	const term = process.env.TERM ?? "";
	if (term.includes("256color")) return "256";
	return "16";
}

/** Resets foreground only — preserves background set by outer Box/bgFn. */
export const FG_RESET = "\x1b[39m";

export function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function fgCode(token: ColorToken, depth: ColorDepth): string {
	if (depth === "truecolor" && token.truecolor) {
		const [r, g, b] = hexToRgb(token.truecolor);
		return `\x1b[38;2;${r};${g};${b}m`;
	}
	if ((depth === "truecolor" || depth === "256") && token.ansi256 !== undefined) {
		return `\x1b[38;5;${token.ansi256}m`;
	}
	if (token.ansi16 !== undefined) return `\x1b[${token.ansi16}m`;
	return "";
}

export function color(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	return c ? `${c}${text}${FG_RESET}` : text;
}

export function bg(text: string, token: ColorToken): string {
	const depth = colorDepth();
	if (depth === "truecolor" && token.truecolor) {
		const [r, g, b] = hexToRgb(token.truecolor);
		return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
	}
	if ((depth === "truecolor" || depth === "256") && token.ansi256 !== undefined) {
		return `\x1b[48;5;${token.ansi256}m${text}\x1b[49m`;
	}
	if (token.ansi16 !== undefined) {
		return `\x1b[${token.ansi16}m${text}\x1b[49m`;
	}
	return text;
}

export const bold = (text: string): string => chalk.bold(text);
export const dim = (text: string): string => chalk.dim(text);
export const italic = (text: string): string => chalk.italic(text);

const _nerdFonts = process.env.ALEF_NERD_FONTS === "1";

export function nerdFontsAvailable(): boolean {
	return _nerdFonts;
}

interface GlyphPair {
	nerd: string;
	ascii: string;
}

const GLYPHS: Record<string, GlyphPair> = {
	"state:done": { nerd: "■", ascii: "■" },
	"state:active": { nerd: "●", ascii: "●" },
	"state:error": { nerd: "▲", ascii: "▲" },
	"state:pending": { nerd: "○", ascii: "." },
	user: { nerd: "▸", ascii: ">" },
	bullet: { nerd: "▪", ascii: "*" },
	sep: { nerd: "─", ascii: "-" },
	dot: { nerd: "·", ascii: "." },
};

export function glyph(key: string): string {
	const pair = GLYPHS[key];
	if (!pair) return key;
	return _nerdFonts ? pair.nerd : pair.ascii;
}
