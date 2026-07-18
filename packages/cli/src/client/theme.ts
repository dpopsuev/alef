import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userThemePath } from "@dpopsuev/alef-kernel/xdg";
import { parse as parseYaml } from "yaml";

export type { ColorDepth, ColorToken, ThemeTokens } from "@dpopsuev/alef-tui";
export {
	bg,
	bold,
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

import type { ColorToken, SelectListTheme, ThemeTokens } from "@dpopsuev/alef-tui";
import { color, colorDepth, FG_RESET, fgCode, hexToRgb, nerdFontsAvailable } from "@dpopsuev/alef-tui";
import chalk from "chalk";

const ANSI_FG_START = 30;
const ANSI_BRIGHT_START = 90;
const ANSI_BRIGHT_OFFSET = 8;
const DEFAULT_SPINNER_FRAMES = 12;

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
		const idx = code >= ANSI_BRIGHT_START ? code - ANSI_BRIGHT_START + ANSI_BRIGHT_OFFSET : code - ANSI_FG_START;
		if (idx >= 0 && idx <= 15) return chalk.ansi256(idx);
	}
	return chalk;
}

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

/** Render text with both bold and color applied using raw ANSI escape sequences. */
export function boldColor(text: string, token: ColorToken): string {
	const c = fgCode(token, colorDepth());
	return c ? `${BOLD_ON}${c}${text}${FG_RESET}${BOLD_OFF}` : `${BOLD_ON}${text}${BOLD_OFF}`;
}

/**
 * SelectList theme variants — shared chrome for :commands, session, blueprint, overlays.
 * Selected = accentFg (brand focus); unselected = muted; selected description = brightFg.
 * Variants only change weight (bold), never which role paints the selection.
 */
export type SelectListThemeVariant = "accent" | "bold" | "accent-bold-text" | "accent-bold-color";

/** Build a SelectListTheme from TUI tokens. */
export function selectListThemeFromTokens(t: ThemeTokens, variant: SelectListThemeVariant = "accent"): SelectListTheme {
	const muted = (s: string) => color(s, t.mutedFg);
	const bright = (s: string) => color(s, t.brightFg);
	const useBold = variant === "bold" || variant === "accent-bold-text" || variant === "accent-bold-color";
	const selected = useBold ? (s: string) => boldColor(s, t.accentFg) : (s: string) => color(s, t.accentFg);
	return {
		selectedPrefix: selected,
		selectedText: selected,
		unselectedText: muted,
		description: muted,
		selectedDescription: bright,
		scrollInfo: muted,
		noMatch: muted,
	};
}

const TERMINAL: ThemeTokens = {
	userFg: { ansi16: 95 }, // bright magenta
	userBg: { ansi16: 45 }, // magenta bg — 16-color only (dark terminals)
	agentBg: { ansi16: 40 }, // dark green bg — visible but subtle on dark terminals
	agentFg: { ansi16: 96 }, // bright cyan
	primaryFg: { ansi16: 94 }, // bright blue — structural emphasis
	secondaryFg: { ansi16: 36 },
	mutedFg: { ansi16: 90 },
	accentFg: { ansi16: 95 }, // bright magenta — brand / interactive
	brightFg: { ansi16: 97 }, // bright white — selected-row secondary text
	okFg: { ansi16: 32 }, // green
	warnFg: { ansi16: 33 }, // yellow
	errFg: { ansi16: 31 }, // red
};

const AKKO: ThemeTokens = {
	userFg: { truecolor: "#e890a8", ansi256: 211, ansi16: 95 },
	userBg: { truecolor: "#2a1a22", ansi256: 52, ansi16: 45 }, // very dark rose
	agentBg: { truecolor: "#0e1a22", ansi256: 17, ansi16: 40 }, // very dark blue-gray
	agentFg: { truecolor: "#9eb8ca", ansi256: 110, ansi16: 36 },
	primaryFg: { truecolor: "#6b9ecf", ansi256: 74, ansi16: 94 },
	secondaryFg: { ansi16: 90 },
	mutedFg: { ansi16: 90 },
	accentFg: { truecolor: "#c55778", ansi256: 168, ansi16: 35 },
	brightFg: { truecolor: "#f0f0f0", ansi256: 255, ansi16: 97 },
	okFg: { truecolor: "#50a06c", ansi256: 71, ansi16: 32 },
	warnFg: { truecolor: "#d09e48", ansi256: 178, ansi16: 33 },
	errFg: { truecolor: "#f04060", ansi256: 204, ansi16: 91 },
};

const MONO: ThemeTokens = {
	userFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	userBg: { truecolor: "#1a1a1a", ansi256: 235, ansi16: 40 }, // near-black
	agentBg: { truecolor: "#111111", ansi256: 233, ansi16: 40 }, // slightly lighter near-black
	agentFg: { truecolor: "#cccccc", ansi256: 7, ansi16: 37 },
	primaryFg: { truecolor: "#dddddd", ansi256: 253, ansi16: 37 },
	secondaryFg: { ansi16: 90 },
	mutedFg: { ansi16: 90 },
	accentFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	brightFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
	okFg: { truecolor: "#cccccc", ansi256: 7, ansi16: 37 },
	warnFg: { truecolor: "#aaaaaa", ansi256: 7, ansi16: 37 },
	errFg: { truecolor: "#ffffff", ansi256: 15, ansi16: 97 },
};

const MATRIX: ThemeTokens = {
	userFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	userBg: { truecolor: "#001a00", ansi256: 22, ansi16: 42 }, // very dark green
	agentBg: { truecolor: "#001400", ansi256: 22, ansi16: 42 }, // slightly different green-black
	agentFg: { truecolor: "#00bb2d", ansi256: 34, ansi16: 32 },
	primaryFg: { truecolor: "#00cc33", ansi256: 40, ansi16: 32 },
	secondaryFg: { ansi16: 90 },
	mutedFg: { ansi16: 90 },
	accentFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	brightFg: { truecolor: "#e0ffe0", ansi256: 194, ansi16: 97 },
	okFg: { truecolor: "#00ff41", ansi256: 46, ansi16: 92 },
	warnFg: { truecolor: "#ffff00", ansi256: 226, ansi16: 93 },
	errFg: { truecolor: "#ff0000", ansi256: 196, ansi16: 91 },
};

/** Terminal theme variant for light backgrounds — same 16-color palette but a
 * lighter userBg (bright white bg, ansi16=107) so the user block is visible
 * on light terminals without clashing with the background. */
const TERMINAL_LIGHT: ThemeTokens = {
	...TERMINAL,
	userBg: { ansi16: 107 }, // bright green bg — visible on white/light terminals
};

/** Map of built-in theme names to their token palettes. */
export const BUILT_IN_THEMES: Record<string, ThemeTokens> = {
	terminal: TERMINAL,
	"terminal-light": TERMINAL_LIGHT,
	akko: AKKO,
	mono: MONO,
	matrix: MATRIX,
};

let _active: ThemeTokens = TERMINAL;

/** Return the currently active theme token palette. */
export function getTheme(): ThemeTokens {
	return _active;
}

/** Replace the active theme token palette. */
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
			.filter((v): v is string => Boolean(v))
			.flatMap((v) => v.split(":"))[0] ?? "en";
	const code = raw.split("_")[0]!.split(".")[0]!.toLowerCase();
	return LANG_ALIAS[code] ?? code;
}

/** Return shuffled spinner frames from the user's locale script. */
export function spinnerFrames(count = DEFAULT_SPINNER_FRAMES): string[] {
	const lang = systemLang();
	const glyphs = SCRIPT_GLYPHS[lang];
	const pool = [...(glyphs ?? SCRIPT_GLYPHS.default!)];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j]!, pool[i]!];
	}
	return pool.slice(0, count);
}

/**
 * Build a TERMINAL theme variant enriched with the user's actual terminal
 * palette colors from OSC 4 queries.
 *
 * Slot → semantic role mapping:
 *   13 bright magenta → userFg / accentFg (brand + interactive)
 *    5 dark magenta   → userBg
 *   14 bright cyan    → agentFg
 *    6 dark cyan      → agentBg
 *   12 bright blue    → primaryFg (structural emphasis)
 *   15 bright white   → brightFg (selected-row secondary text)
 *    8 bright black   → mutedFg / secondaryFg
 *   10 bright green   → okFg
 *    9 bright red     → errFg
 *   11 bright yellow  → warnFg
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
		primaryFg: tok(12, 94), // bright blue
		secondaryFg: tok(8, 90),
		mutedFg: tok(8, 90),
		accentFg: tok(13, 95), // brand — same slot as userFg
		brightFg: tok(15, 97),
		okFg: tok(10, 92), // bright green
		warnFg: tok(11, 93), // bright yellow
		errFg: tok(9, 91), // bright red
	};
}

/** Palette slots queried at startup to build the terminal theme. */
export const TERMINAL_PALETTE_SLOTS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

/** Activate a built-in theme by name, falling back to terminal if unknown. */
export function setThemeByName(name: string): void {
	const t = BUILT_IN_THEMES[name.toLowerCase()];
	if (!t) {
		process.stderr.write(`[alef] unknown theme '${name}', using terminal\n`);
		_active = TERMINAL;
	} else {
		_active = t;
	}
}

interface ThemeManifest {
	theme?: string;
	colors?: Partial<Record<keyof ThemeTokens, string>>;
}

/** Parse a YAML theme manifest file, returning null on read or parse failure. */
function loadManifest(path: string): ThemeManifest | null {
	try {
		const raw = readFileSync(path, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- YAML config shape is well-known
		return parseYaml(raw) as ThemeManifest;
	} catch {
		return null;
	}
}

/** Create a truecolor-only ColorToken from a hex color string. */
function hexToken(hex: string): ColorToken {
	return { truecolor: hex };
}

/** Load theme from blueprint, user config, or terminal palette and set it as active. */
export function loadTheme(
	blueprintDir?: string,
	cfgThemeName?: string,
	cfgColors?: Record<string, string>,
	isDark = true,
	/** Terminal palette from OSC 4 queries — used to enrich the terminal theme with real colors. */
	terminalPalette: Record<number, string> = {},
): void {
	// Priority: blueprint agent.yaml > $XDG_CONFIG_HOME/alef/theme.yaml > config.yaml theme section
	const candidates = [blueprintDir ? join(blueprintDir, "agent.yaml") : null, userThemePath()].filter(
		(p): p is string => p !== null,
	);

	let manifest: ThemeManifest | null = null;
	for (const path of candidates) {
		manifest = loadManifest(path);
		if (manifest) break;
	}

	// Default is 'terminal' for dark terminals, 'terminal-light' for light terminals.
	// OSC 11 detection in detectDark() already ran before this call.
	const defaultTheme = isDark ? "terminal" : "terminal-light";
	const baseName = manifest?.theme ?? cfgThemeName ?? defaultTheme;

	if ((baseName === "terminal" || baseName === "terminal-light") && Object.keys(terminalPalette).length > 0) {
		setTheme(buildTerminalTheme(terminalPalette));
	} else {
		setThemeByName(baseName);
	}

	const allColors: Record<string, string> = { ...cfgColors, ...manifest?.colors };
	if (Object.keys(allColors).length === 0) return;

	const base = BUILT_IN_THEMES[baseName.toLowerCase()] ?? BUILT_IN_THEMES.terminal!;
	const overrides: Partial<Record<keyof ThemeTokens, ColorToken>> = {};
	for (const [k, v] of Object.entries(allColors)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- user config keys mapped to ThemeTokens; unknown keys are harmless
		if (typeof v === "string") overrides[k as keyof ThemeTokens] = hexToken(v);
	}

	setTheme({ ...base, ...overrides });
}
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

/** Union of all known glyph identifiers (state indicators, separators, bullets). */
export type GlyphKey = keyof typeof GLYPHS;

/** Return the appropriate glyph string for the given key, preferring Nerd Font variants. */
export function glyph(key: GlyphKey): string {
	const pair = GLYPHS[key];
	return nerdFontsAvailable() ? pair.nerd : pair.ascii;
}

/** Color token and display label for an LLM provider. */
export interface ProviderColor {
	token: ColorToken;
	label: string;
}

const PROVIDER_COLORS: Record<string, ProviderColor> = {
	anthropic: { label: "Anthropic", token: { truecolor: "#d97757", ansi256: 208, ansi16: 33 } },
	google: { label: "Google", token: { truecolor: "#4285F4", ansi256: 33, ansi16: 34 } },
	"google-vertex": { label: "Vertex", token: { truecolor: "#34A853", ansi256: 35, ansi16: 32 } },
	openai: { label: "OpenAI", token: { truecolor: "#10A37F", ansi256: 36, ansi16: 36 } },
	"amazon-bedrock": { label: "Bedrock", token: { truecolor: "#FF9900", ansi256: 214, ansi16: 33 } },
	groq: { label: "Groq", token: { truecolor: "#F55036", ansi256: 196, ansi16: 31 } },
	openrouter: { label: "OpenRouter", token: { truecolor: "#6366F1", ansi256: 99, ansi16: 35 } },
	mistral: { label: "Mistral", token: { truecolor: "#FF7000", ansi256: 202, ansi16: 33 } },
	xai: { label: "xAI", token: { truecolor: "#FFFFFF", ansi256: 255, ansi16: 37 } },
	cerebras: { label: "Cerebras", token: { truecolor: "#0066FF", ansi256: 27, ansi16: 34 } },
	deepseek: { label: "DeepSeek", token: { truecolor: "#4D6BFE", ansi256: 69, ansi16: 34 } },
	fireworks: { label: "Fireworks", token: { truecolor: "#FF6B35", ansi256: 209, ansi16: 33 } },
	together: { label: "Together", token: { truecolor: "#0A84FF", ansi256: 39, ansi16: 34 } },
	huggingface: { label: "HuggingFace", token: { truecolor: "#FFD21E", ansi256: 220, ansi16: 33 } },
};

const FALLBACK: ProviderColor = { label: "Unknown", token: { ansi256: 245, ansi16: 37 } };

/** Look up the brand color for an LLM provider, returning a neutral fallback if unknown. */
export function getProviderColor(provider: string): ProviderColor {
	return PROVIDER_COLORS[provider] ?? FALLBACK;
}

/** Return a read-only map of all registered provider names to their brand colors. */
export function allProviderColors(): ReadonlyMap<string, ProviderColor> {
	return new Map(Object.entries(PROVIDER_COLORS));
}

// ---------------------------------------------------------------------------
// OSC 4 terminal palette query
// ---------------------------------------------------------------------------

const PALETTE_QUERY_TIMEOUT_MS = 200;
const OSC4_ESC = "\x1b";
const OSC4_BEL = "\x07";
const osc4Query = (slot: number) => `${OSC4_ESC}]4;${slot};?${OSC4_BEL}`;
const COLOR_CHANNEL_8BIT = 255;
const COLOR_CHANNEL_16BIT = 65535;
const COLOR_CHANNEL_8BIT_LENGTH = 2;

/** Query the terminal's actual RGB values for ANSI color slots via OSC 4. */
export async function queryPalette(
	slots: readonly number[],
	timeoutMs = PALETTE_QUERY_TIMEOUT_MS,
): Promise<Record<number, string>> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return {};
	const term = process.env.TERM ?? "";
	if (term.startsWith("tmux") || term.startsWith("screen")) return {};
	if (slots.length === 0) return {};

	return new Promise((resolve) => {
		const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
		const wasRaw = stdin.isRaw;
		const result: Record<number, string> = {};
		const pending = new Set(slots);
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			try {
				if (!wasRaw) stdin.setRawMode(false);
			} catch {
				/* ignore */
			}
			resolve(result);
		};

		const timer = setTimeout(finish, timeoutMs);

		let buf = "";
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString();
			const re = /\x1b\]4;(\d+);rgb:([\da-fA-F]+)\/([\da-fA-F]+)\/([\da-fA-F]+)[\x07\x1b\\]/g;
			for (;;) {
				const m = re.exec(buf);
				if (!m) break;
				const slot = Number(m[1]);
				const scale = m[2]!.length <= COLOR_CHANNEL_8BIT_LENGTH ? COLOR_CHANNEL_8BIT : COLOR_CHANNEL_16BIT;
				const r = Math.round((parseInt(m[2]!, 16) / scale) * 255);
				const g = Math.round((parseInt(m[3]!, 16) / scale) * 255);
				const b = Math.round((parseInt(m[4]!, 16) / scale) * 255);
				result[slot] =
					`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
				pending.delete(slot);
			}
			if (pending.size === 0) finish();
		};

		try {
			stdin.setRawMode(true);
			stdin.resume();
			stdin.on("data", onData);
			process.stdout.write(slots.map((n) => osc4Query(n)).join(""));
		} catch {
			finish();
		}
	});
}
