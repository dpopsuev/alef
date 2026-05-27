// Pure ANSI primitives are defined in ansi.ts and re-exported here for
// backward-compat. theme.ts owns the theme singleton and ThemeTokens.

export type { ColorDepth, ColorToken } from "./tui/ansi.js";
export { bg, bold, color, colorDepth, dim, fgCode, glyph, italic, nerdFontsAvailable } from "./tui/ansi.js";

// FG_RESET kept internal — consumers should use color() instead.
import { type ColorToken, colorDepth, FG_RESET, fgCode } from "./tui/ansi.js";

export interface ThemeTokens {
	userFg: ColorToken;
	/** Background color for the user message block (Pi pattern: Box with bgFn). */
	userBg: ColorToken;
	/** Background for agent reply blocks. Empty token = no background (transparent). */
	agentBg: ColorToken;
	agentFg: ColorToken;
	toolNameFg: ColorToken;
	toolArgFg: ColorToken;
	toolOkFg: ColorToken;
	toolErrFg: ColorToken;
	accentFg: ColorToken;
	dimFg: ColorToken;
	okFg: ColorToken;
	warnFg: ColorToken;
	errFg: ColorToken;
	timeFg: ColorToken;
	modelFg: ColorToken;
}

import chalk from "chalk";
import { hexToRgb } from "./tui/ansi.js";

/**
 * Return a chalk instance pre-configured for a theme token's color.
 * Use this instead of fgCode() wherever chalk can drive the output.
 */
export function chalkForToken(token: ColorToken): typeof chalk {
	const depth = colorDepth();
	if (depth === "truecolor" && token.truecolor) {
		const [r, g, b] = hexToRgb(token.truecolor);
		return chalk.rgb(r, g, b);
	}
	if ((depth === "truecolor" || depth === "256") && token.ansi256 !== undefined) {
		return chalk.ansi256(token.ansi256);
	}
	if (token.ansi16 !== undefined) {
		// SGR 30-37 → palette index 0-7, SGR 90-97 → palette index 8-15
		const code = token.ansi16;
		const idx = code >= 90 ? code - 90 + 8 : code - 30;
		if (idx >= 0 && idx <= 15) return chalk.ansi256(idx);
	}
	return chalk;
}

/** Apply a theme token color and bold.
 * Uses raw ANSI so it works regardless of chalk's TTY/color-level detection,
 * and uses FG_RESET (\x1b[39m) to preserve any background set by an outer Box.
 */
export function boldColor(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	// \x1b[1m = bold on, \x1b[22m = bold off (intensity reset only, not full reset)
	return c ? `\x1b[1m${c}${text}${FG_RESET}\x1b[22m` : `\x1b[1m${text}\x1b[22m`;
}

const TERMINAL: ThemeTokens = {
	userFg: { ansi16: 95 }, // bright magenta
	userBg: { ansi16: 45 }, // magenta bg — 16-color only (dark terminals)
	agentBg: { ansi16: 40 }, // dark green bg — visible but subtle on dark terminals
	agentFg: { ansi16: 96 }, // bright cyan
	toolNameFg: { ansi16: 34 }, // blue
	toolArgFg: { ansi16: 90 },
	toolOkFg: { ansi16: 32 }, // green
	toolErrFg: { ansi16: 31 }, // red
	accentFg: { ansi16: 95 }, // bright magenta
	dimFg: { ansi16: 90 },
	okFg: { ansi16: 32 }, // green
	warnFg: { ansi16: 33 }, // yellow
	errFg: { ansi16: 31 }, // red
	timeFg: { ansi16: 90 },
	modelFg: { ansi16: 37 },
};

const AKKO: ThemeTokens = {
	userFg: { truecolor: "#e890a8", ansi256: 211, ansi16: 95 },
	userBg: { truecolor: "#2a1a22", ansi256: 52, ansi16: 45 }, // very dark rose
	agentBg: { truecolor: "#0e1a22", ansi256: 17, ansi16: 40 }, // very dark blue-gray
	agentFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 },
	toolNameFg: { truecolor: "#6d9aba", ansi256: 67, ansi16: 34 },
	toolArgFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 },
	toolOkFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 },
	toolErrFg: { truecolor: "#f04060", ansi256: 204, ansi16: 91 }, // brightened: #c22848 was 3.1:1 on agentBg (need 4.5:1)
	accentFg: { truecolor: "#c55778", ansi256: 168, ansi16: 35 },
	dimFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 },
	okFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 },
	warnFg: { truecolor: "#d09e48", ansi256: 178, ansi16: 33 },
	errFg: { truecolor: "#c22848", ansi256: 161, ansi16: 31 },
	timeFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 },
	modelFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 },
};

const MONO: ThemeTokens = {
	userFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	userBg: { truecolor: "#1a1a1a", ansi256: 235, ansi16: 40 }, // near-black
	agentBg: { truecolor: "#111111", ansi256: 233, ansi16: 40 }, // slightly lighter near-black
	agentFg: { truecolor: "#cccccc", ansi256: 7, ansi16: 37 },
	toolNameFg: { truecolor: "#aaaaaa", ansi256: 7, ansi16: 37 },
	toolArgFg: { truecolor: "#777777", ansi256: 8, ansi16: 90 },
	toolOkFg: { truecolor: "#cccccc", ansi256: 7, ansi16: 37 },
	toolErrFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	accentFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	dimFg: { truecolor: "#555555", ansi256: 8, ansi16: 90 },
	okFg: { truecolor: "#cccccc", ansi256: 7, ansi16: 37 },
	warnFg: { truecolor: "#aaaaaa", ansi256: 7, ansi16: 37 },
	errFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	timeFg: { truecolor: "#555555", ansi256: 8, ansi16: 90 },
	modelFg: { truecolor: "#aaaaaa", ansi256: 7, ansi16: 37 },
};

const MATRIX: ThemeTokens = {
	userFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	userBg: { truecolor: "#001a00", ansi256: 22, ansi16: 42 }, // very dark green
	agentBg: { truecolor: "#001400", ansi256: 22, ansi16: 42 }, // slightly different green-black
	agentFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
	toolNameFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
	toolArgFg: { truecolor: "#006614", ansi256: 22, ansi16: 32 },
	toolOkFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	toolErrFg: { truecolor: "#ff0000", ansi256: 196, ansi16: 91 },
	accentFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	dimFg: { truecolor: "#1a5c1a", ansi256: 22, ansi16: 32 }, // brightened: #003b00 was 1.48:1 on agentBg (need 1.5:1)
	okFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	warnFg: { truecolor: "#ffff00", ansi256: 226, ansi16: 93 },
	errFg: { truecolor: "#ff0000", ansi256: 196, ansi16: 91 },
	timeFg: { truecolor: "#006614", ansi256: 22, ansi16: 32 },
	modelFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
};

/** Terminal theme variant for light backgrounds — same 16-color palette but a
 * lighter userBg (bright white bg, ansi16=107) so the user block is visible
 * on light terminals without clashing with the background. */
const TERMINAL_LIGHT: ThemeTokens = {
	...TERMINAL,
	userBg: { ansi16: 107 }, // bright green bg — visible on white/light terminals
};

export const BUILT_IN_THEMES: Record<string, ThemeTokens> = {
	terminal: TERMINAL,
	"terminal-light": TERMINAL_LIGHT,
	akko: AKKO,
	mono: MONO,
	matrix: MATRIX,
};

let _active: ThemeTokens = TERMINAL;

export function getTheme(): ThemeTokens {
	return _active;
}

export function setTheme(tokens: ThemeTokens): void {
	_active = tokens;
}

const SCRIPT_GLYPHS: Record<string, readonly string[]> = {
	ja: ["ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク", "ケ", "コ", "あ", "い", "う", "え", "お", "か"],
	zh: ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "百", "千", "万", "天", "地", "人"],
	ko: ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하", "가", "나"],
	ar: ["ب", "ج", "د", "ر", "ز", "س", "ش", "ص", "ط", "ع", "ف", "ق", "ك", "ل", "م", "ن"],
	he: ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "כ", "ל", "מ", "נ", "ס", "ע"],
	hi: ["अ", "आ", "इ", "ई", "उ", "ए", "ओ", "क", "ग", "ज", "ड", "न", "प", "म", "र", "व"],
	th: ["ก", "ข", "ค", "ง", "จ", "ฉ", "ช", "ด", "ต", "น", "บ", "ผ", "ม", "ร", "ว", "ส"],
	ru: ["Б", "В", "Г", "Д", "Ж", "З", "И", "К", "Л", "М", "Н", "П", "Р", "С", "Т", "Ф"],
	el: ["α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "π", "ρ"],
	ka: ["ა", "ბ", "გ", "დ", "ე", "ვ", "ზ", "თ", "ი", "კ", "ლ", "მ", "ნ", "ო", "პ", "ჟ"],
	hy: ["Ա", "Բ", "Գ", "Դ", "Ե", "Զ", "Է", "Ը", "Թ", "Ժ", "Ի", "Լ", "Խ", "Ծ", "Կ", "Հ"],
	am: ["ሀ", "ሁ", "ሂ", "ሃ", "ለ", "ሉ", "ሊ", "ሐ", "መ", "ሠ", "ረ", "ሰ", "ሸ", "ቀ", "በ", "ተ"],
	// Latin-script languages: use mathematical/geometric symbols (universally supported)
	default: ["∀", "∂", "∃", "∅", "∆", "∇", "∏", "∑", "∞", "∫", "≈", "≠", "≤", "≥", "◆", "◊"],
};

const LANG_ALIAS: Record<string, string> = {
	zh_tw: "zh",
	zh_hk: "zh",
	zh_sg: "zh",
	mr: "hi",
	ne: "hi",
	kok: "hi",
	uk: "ru",
	bg: "ru",
	sr: "ru",
	mk: "ru",
	be: "ru",
	ti: "am",
};

/** Parse locale env vars and return the primary language code. */
export function systemLang(): string {
	const raw =
		[process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, process.env.LANGUAGE]
			.filter(Boolean)
			.flatMap((v) => (v as string).split(":"))[0] ?? "en";
	const code = raw.split("_")[0].split(".")[0].toLowerCase();
	return LANG_ALIAS[code] ?? code;
}

/** Return shuffled spinner frames from the user's locale script. */
export function spinnerFrames(count = 12): string[] {
	const lang = systemLang();
	const pool = [...(SCRIPT_GLYPHS[lang] ?? SCRIPT_GLYPHS.default ?? [])];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, count);
}

/**
 * Build a TERMINAL theme variant enriched with the user's actual terminal
 * palette colors from OSC 4 queries.
 *
 * Slot → semantic role mapping:
 *   13 bright magenta → userFg / accentFg
 *    5 dark magenta   → userBg  (as fg code; bg() applies the +10 offset)
 *   14 bright cyan    → agentFg
 *    6 dark cyan      → agentBg
 *   12 bright blue    → toolNameFg
 *    8 bright black   → dimFg / toolArgFg / timeFg
 *   10 bright green   → toolOkFg / okFg
 *    9 bright red     → toolErrFg / errFg
 *   11 bright yellow  → warnFg
 *    7 light gray     → modelFg
 *
 * When a slot's truecolor is known, it is stored alongside the ansi16 fallback
 * so fgCode() / bg() can use it on truecolor-capable terminals.
 */
export function buildTerminalTheme(palette: Record<number, string>): ThemeTokens {
	const tok = (slot: number, ansi16: number): ColorToken => {
		const truecolor = palette[slot];
		return truecolor ? { truecolor, ansi16 } : { ansi16 };
	};
	// Background slots: the ansi16 bg codes are fg+10, but ColorToken.ansi16
	// stores the raw background code (40-47) directly — bg() never adds 10.
	const bgTok = (slot: number, bgCode: number): ColorToken => {
		const truecolor = palette[slot];
		return truecolor ? { truecolor, ansi16: bgCode } : { ansi16: bgCode };
	};
	return {
		userFg: tok(13, 95), // bright magenta
		userBg: bgTok(5, 45), // dark magenta bg
		agentBg: bgTok(6, 40), // dark cyan bg
		agentFg: tok(14, 96), // bright cyan
		toolNameFg: tok(12, 34), // bright blue (ansi16=34 = dark blue; some terms map bright blue)
		toolArgFg: tok(8, 90), // bright black
		toolOkFg: tok(10, 32), // bright green
		toolErrFg: tok(9, 31), // bright red
		accentFg: tok(13, 95), // same as userFg
		dimFg: tok(8, 90), // bright black
		okFg: tok(10, 32), // bright green
		warnFg: tok(11, 33), // bright yellow
		errFg: tok(9, 31), // bright red
		timeFg: tok(8, 90), // bright black
		modelFg: tok(7, 37), // light gray
	};
}

/** Palette slots queried at startup to build the terminal theme. */
export const TERMINAL_PALETTE_SLOTS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export function setThemeByName(name: string): void {
	const t = BUILT_IN_THEMES[name.toLowerCase()];
	if (!t) {
		process.stderr.write(`[alef] unknown theme '${name}', using terminal\n`);
		_active = TERMINAL;
	} else {
		_active = t;
	}
}
