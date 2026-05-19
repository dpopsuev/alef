import type {} from "node:process";

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
	truecolor: string;
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

function fgCode(token: ColorToken, depth: ColorDepth): string {
	if (depth === "truecolor") {
		const [r, g, b] = hexToRgb(token.truecolor);
		return `\x1b[38;2;${r};${g};${b}m`;
	}
	if (depth === "256" && token.ansi256 !== undefined) return `\x1b[38;5;${token.ansi256}m`;
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

// Akko Blossom palette — hues: blossom H≈352, sky H≈207, gold H≈38
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
	akko: AKKO,
	mono: MONO,
	matrix: MATRIX,
};

// ---------------------------------------------------------------------------
// Active theme singleton
// ---------------------------------------------------------------------------

let _active: ThemeTokens = AKKO;

export function getTheme(): ThemeTokens {
	return _active;
}

export function setTheme(tokens: ThemeTokens): void {
	_active = tokens;
}

export function setThemeByName(name: string): void {
	const t = BUILT_IN_THEMES[name.toLowerCase()];
	if (!t) {
		process.stderr.write(`[alef] unknown theme '${name}', using akko\n`);
		_active = AKKO;
	} else {
		_active = t;
	}
}
