export {
	bg,
	bold,
	type ColorDepth,
	type ColorToken,
	color,
	colorDepth,
	dim,
	FG_RESET,
	fgCode,
	hexToRgb,
	italic,
	nerdFontsAvailable,
} from "../ansi.js";
export type { Component } from "../component.js";
export { Text } from "../components/text.js";
export { type StatusLevel, type StatusStyle, statusGlyph, statusStyle } from "../design/palette.js";
export type { ThemeTokens } from "../theme-types.js";
export { Container, type TUI } from "../tui.js";

import { nerdFontsAvailable } from "../ansi.js";

interface GlyphPair {
	nerd: string;
	ascii: string;
}

const GLYPHS = {
	"state:done": { nerd: "■", ascii: "■" },
	"state:active": { nerd: "●", ascii: "●" },
	"state:error": { nerd: "▲", ascii: "▲" },
	"state:pending": { nerd: "○", ascii: "○" },
	"state:pruned": { nerd: "×", ascii: "×" },
	"state:deferred": { nerd: "◇", ascii: "◇" },
	"state:current": { nerd: "◄", ascii: "◄" },
	"state:batch": { nerd: "⏱", ascii: "~" },
	user: { nerd: "▸", ascii: ">" },
	bullet: { nerd: "▪", ascii: "*" },
	sep: { nerd: "─", ascii: "-" },
	dot: { nerd: "·", ascii: "." },
} satisfies Record<string, GlyphPair>;

export type GlyphKey = keyof typeof GLYPHS;

export function glyph(key: GlyphKey): string {
	const pair = GLYPHS[key];
	return nerdFontsAvailable() ? pair.nerd : pair.ascii;
}
