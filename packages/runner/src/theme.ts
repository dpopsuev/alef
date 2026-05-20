// ---------------------------------------------------------------------------
// Color depth
// ---------------------------------------------------------------------------

export type ColorDepth = "truecolor" | "256" | "16";

export function colorDepth(): ColorDepth {
	const ct = (process.env.COLORTERM ?? "").toLowerCase();
	if (ct === "truecolor" || ct === "24bit") return "truecolor";
	const term = process.env.TERM ?? "";
	if (term.includes("256color") || ct === "256color") return "256";
	return "16";
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface ColorToken {
	truecolor?: string; // absent in terminal theme — falls through to ansi16
	ansi256?: number;
	ansi16?: number;
}

export interface ThemeTokens {
	userFg: ColorToken;
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

// ---------------------------------------------------------------------------
// ANSI rendering
// ---------------------------------------------------------------------------

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

function hexToRgb(hex: string): [number, number, number] {
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
	return c ? `${c}${text}${RESET}` : text;
}

export function bold(text: string): string {
	return `${BOLD}${text}${RESET}`;
}

export function boldColor(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	return c ? `${BOLD}${c}${text}${RESET}` : `${BOLD}${text}${RESET}`;
}

export function dim(text: string): string {
	return `${DIM}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

// Terminal theme — pure ANSI 16-color, no hex.
// The terminal maps these SGR codes to whatever the user configured.
const TERMINAL: ThemeTokens = {
	userFg: { ansi16: 95 }, // bright magenta
	agentFg: { ansi16: 96 }, // bright cyan
	toolNameFg: { ansi16: 34 }, // blue
	toolArgFg: { ansi16: 90 }, // dark grey
	toolOkFg: { ansi16: 32 }, // green
	toolErrFg: { ansi16: 31 }, // red
	accentFg: { ansi16: 95 }, // bright magenta
	dimFg: { ansi16: 90 }, // dark grey
	okFg: { ansi16: 32 }, // green
	warnFg: { ansi16: 33 }, // yellow
	errFg: { ansi16: 31 }, // red
	timeFg: { ansi16: 90 }, // dark grey
	modelFg: { ansi16: 37 }, // light grey
};

// Akko Blossom — opt-in truecolor palette for users who want exact hex.
const AKKO: ThemeTokens = {
	userFg: { truecolor: "#e890a8", ansi256: 211, ansi16: 95 }, // bloom
	agentFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 }, // cloud
	toolNameFg: { truecolor: "#6d9aba", ansi256: 67, ansi16: 34 }, // sky
	toolArgFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 }, // dim
	toolOkFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 }, // ok
	toolErrFg: { truecolor: "#c22848", ansi256: 161, ansi16: 31 }, // err
	accentFg: { truecolor: "#c55778", ansi256: 168, ansi16: 35 }, // blossom
	dimFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 }, // dim
	okFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 }, // ok
	warnFg: { truecolor: "#d09e48", ansi256: 178, ansi16: 33 }, // gold
	errFg: { truecolor: "#c22848", ansi256: 161, ansi16: 31 }, // err
	timeFg: { truecolor: "#8e6878", ansi256: 95, ansi16: 90 }, // dim
	modelFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 }, // cloud
};

const MONO: ThemeTokens = {
	userFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
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

// ---------------------------------------------------------------------------
// Active theme singleton
// ---------------------------------------------------------------------------

let _active: ThemeTokens = TERMINAL;

export function getTheme(): ThemeTokens {
	return _active;
}

export function setTheme(tokens: ThemeTokens): void {
	_active = tokens;
}

// ---------------------------------------------------------------------------
// Spinner glyphs — locale-aware
// ---------------------------------------------------------------------------

// Glyphs chosen from each script for visual weight at terminal font sizes.
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

// Language code aliases — maps to the canonical key in SCRIPT_GLYPHS.
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

// ---------------------------------------------------------------------------
// Nerd Font detection + glyph system
// ---------------------------------------------------------------------------

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
