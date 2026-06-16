import type { ColorToken } from "./tui/ansi.js";

export type { ColorDepth, ColorToken } from "./tui/ansi.js";

/**
 * Semantic color system for the Alef TUI.
 *
 * Colors are named by ROLE, not hue. The theme maps these to actual
 * ColorTokens. Widget code references semantics, never raw colors.
 *
 * Hierarchy (by visual weight):
 *   primary > secondary > muted
 *
 * Status:
 *   ok (green) > warn (yellow) > err (red)
 *
 * Identity (per-actor):
 *   userFg, agentFg — set at session start from actor palette
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
	okFg: ColorToken;
	warnFg: ColorToken;
	errFg: ColorToken;
}
