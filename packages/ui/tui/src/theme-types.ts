import type { ColorToken } from "./ansi.js";

export type { ColorDepth, ColorToken } from "./ansi.js";

/**
 * Semantic color system for the Alef TUI.
 *
 * Colors are named by ROLE, not hue. Theme tables / OSC / config map roles
 * to ColorTokens. Widget code references roles only — never raw SGR/hex.
 *
 * Role contract (unified):
 *   accentFg   — brand + interactive focus (INSERT, SelectList selection,
 *                topic title, mode hints, settings cursor, thinking)
 *   primaryFg  — strong non-brand emphasis (cards, task detail, structural CTA)
 *   secondaryFg — supporting labels
 *   mutedFg    — borders, dim meta, unselected list text, ghost hints
 *   brightFg   — high-contrast secondary text on a focused/selected row
 *   userFg/Bg, agentFg/Bg — speaker-label identity only (not message body text)
 *   okFg / warnFg / errFg — status only
 *
 * ANSI 16 baseline: every token must have an ansi16 fallback.
 */
export interface ThemeTokens {
	userFg: ColorToken;
	userBg: ColorToken;
	agentFg: ColorToken;
	agentBg: ColorToken;
	primaryFg: ColorToken;
	secondaryFg: ColorToken;
	mutedFg: ColorToken;
	accentFg: ColorToken;
	brightFg: ColorToken;
	okFg: ColorToken;
	warnFg: ColorToken;
	errFg: ColorToken;
}
