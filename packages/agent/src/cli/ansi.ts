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

const GLYPHS: Record<string, GlyphPair> = {
	"state:done": { nerd: "■", ascii: "■" },
	"state:active": { nerd: "●", ascii: "●" },
	"state:error": { nerd: "▲", ascii: "▲" },
	"state:pending": { nerd: "○", ascii: "○" },
	"state:pruned": { nerd: "×", ascii: "×" },
	"state:deferred": { nerd: "◇", ascii: "◇" },
	"state:current": { nerd: "◄", ascii: "◄" },
	user: { nerd: "▸", ascii: ">" },
	bullet: { nerd: "▪", ascii: "*" },
	sep: { nerd: "─", ascii: "-" },
	dot: { nerd: "·", ascii: "." },
};

export function glyph(key: string): string {
	const pair = GLYPHS[key];
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for unknown glyph keys
	if (!pair) return key;
	return nerdFontsAvailable() ? pair.nerd : pair.ascii;
}
