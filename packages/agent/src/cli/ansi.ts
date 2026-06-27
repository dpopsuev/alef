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
	type StatusLevel,
	type StatusStyle,
	statusGlyph,
	statusStyle,
} from "@dpopsuev/alef-tui";

import { nerdFontsAvailable } from "@dpopsuev/alef-tui";

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
