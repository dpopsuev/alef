export type ColorDepth = "truecolor" | "256" | "16";

export function colorDepth(): ColorDepth {
	const ct = (process.env.COLORTERM ?? "").toLowerCase();
	if (ct === "truecolor" || ct === "24bit") return "truecolor";
	const term = process.env.TERM ?? "";
	if (term.includes("256color") || ct === "256color") return "256";
	return "16";
}

export interface ColorToken {
	truecolor?: string; // absent in terminal theme — falls through to ansi16
	ansi256?: number;
	ansi16?: number;
}

export interface ThemeTokens {
	userFg: ColorToken;
	/** Background color for the user message block (Pi pattern: Box with bgFn). */
	userBg: ColorToken;
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

// Used only inside fgCode where chalk has no ColorToken concept.
const RESET = "\x1b[0m";
/** Resets foreground only — preserves background set by outer Box/bgFn. */
const FG_RESET = "\x1b[39m";

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

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

/** Raw ANSI fg escape for a theme token. Used in splash where chalk cannot apply ColorToken colors. */
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

/** Apply a theme token color to text. */
export function color(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	// Use FG_RESET (\x1b[39m) not RESET (\x1b[0m) so background colors set by
	// outer Box components are preserved. Matches pi's theme.fg() behaviour.
	return c ? `${c}${text}${FG_RESET}` : text;
}

/** Apply a theme token background color to text (for Box bgFn).
 * Uses raw ANSI escape codes like fgCode() — never goes through chalk
 * so it works regardless of chalk's TTY/color-level detection. */
export function bg(text: string, token: ColorToken): string {
	const depth = colorDepth();
	if (depth === "truecolor" && token.truecolor) {
		const [r, g, b] = hexToRgb(token.truecolor);
		// [48;2;R;G;Bm = truecolor background, [49m = default background
		return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
	}
	if ((depth === "truecolor" || depth === "256") && token.ansi256 !== undefined) {
		return `\x1b[48;5;${token.ansi256}m${text}\x1b[49m`;
	}
	// For 16-color: token.ansi16 IS already the background code (40-47, 100-107).
	// The userBg token stores bg codes directly; do NOT add 10.
	if (token.ansi16 !== undefined) {
		return `\x1b[${token.ansi16}m${text}\x1b[49m`;
	}
	return text;
}

/** Apply a theme token color and bold. */
export function boldColor(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	return c ? chalk.bold(`${c}${text}${RESET}`) : chalk.bold(text);
}

export const bold = (text: string): string => chalk.bold(text);
export const dim = (text: string): string => chalk.dim(text);
export const italic = (text: string): string => chalk.italic(text);

const TERMINAL: ThemeTokens = {
	userFg: { ansi16: 95 }, // bright magenta
	userBg: { ansi16: 45 }, // magenta bg — 16-color only
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
	agentFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 },
	toolNameFg: { truecolor: "#6d9aba", ansi256: 67, ansi16: 34 },
	toolArgFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 },
	toolOkFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 },
	toolErrFg: { truecolor: "#c22848", ansi256: 161, ansi16: 31 },
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
	agentFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
	toolNameFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
	toolArgFg: { truecolor: "#006614", ansi256: 22, ansi16: 32 },
	toolOkFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	toolErrFg: { truecolor: "#ff0000", ansi256: 196, ansi16: 91 },
	accentFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	dimFg: { truecolor: "#003b00", ansi256: 22, ansi16: 32 },
	okFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	warnFg: { truecolor: "#ffff00", ansi256: 226, ansi16: 93 },
	errFg: { truecolor: "#ff0000", ansi256: 196, ansi16: 91 },
	timeFg: { truecolor: "#006614", ansi256: 22, ansi16: 32 },
	modelFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
};

export const BUILT_IN_THEMES: Record<string, ThemeTokens> = {
	terminal: TERMINAL,
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

export function setThemeByName(name: string): void {
	const t = BUILT_IN_THEMES[name.toLowerCase()];
	if (!t) {
		process.stderr.write(`[alef] unknown theme '${name}', using terminal\n`);
		_active = TERMINAL;
	} else {
		_active = t;
	}
}

// Opt-in via ALEF_NERD_FONTS=1. Without it, ASCII fallbacks are used so the
// TUI works on any terminal without special font requirements.
const _nerdFonts = process.env.ALEF_NERD_FONTS === "1";

export function nerdFontsAvailable(): boolean {
	return _nerdFonts;
}

interface GlyphPair {
	nerd: string;
	ascii: string;
}

const GLYPHS: Record<string, GlyphPair> = {
	"state:done": { nerd: "⬢", ascii: "✓" },
	"state:active": { nerd: "⬡", ascii: "*" },
	"state:error": { nerd: "●", ascii: "!" },
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
