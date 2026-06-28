/**
 * WCAG contrast audit for all built-in themes.
 *
 * Computes relative luminance contrast ratio for every fg/bg pair that appears
 * together in the TUI. Only checks truecolor hex values (the most accurate
 * signal). ANSI-16 pairs are not checked — no reliable hex mapping.
 *
 * Thresholds (WCAG AA):
 * Body text (toolName, reply, user message): >= 4.5:1
 * Decorative / secondary (dim, time, arg): >= 1.5:1 (pragmatic floor)
 *
 * A failure here means text may be invisible or unreadable on that theme.
 */

import { describe, expect, it } from "vitest";
import type { ThemeTokens } from "../src/client/runner-theme.js";
import { BUILT_IN_THEMES } from "../src/client/runner-theme.js";

// ---------------------------------------------------------------------------
// WCAG luminance and contrast maths
// ---------------------------------------------------------------------------

function linearize(c8: number): number {
	const s = c8 / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const r = linearize(parseInt(h.slice(0, 2), 16));
	const g = linearize(parseInt(h.slice(2, 4), 16));
	const b = linearize(parseInt(h.slice(4, 6), 16));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
	const l1 = luminance(fg);
	const l2 = luminance(bg);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

function hexOf(token: { truecolor?: string } | undefined): string | null {
	return token?.truecolor ?? null;
}

// ---------------------------------------------------------------------------
// Pairs: [fgToken, bgToken, label, minRatio]
// ---------------------------------------------------------------------------

type TokenKey = keyof ThemeTokens;

const BODY_PAIRS: Array<[TokenKey, TokenKey, string]> = [
	["userFg", "userBg", "user message text"],
	["agentFg", "agentBg", "agent reply text"],
	["primaryFg", "agentBg", "primary on agent bg"],
	["okFg", "agentBg", "ok glyph on agent bg"],
	["errFg", "agentBg", "error glyph on agent bg"],
];

const SECONDARY_PAIRS: Array<[TokenKey, TokenKey, string]> = [
	["secondaryFg", "agentBg", "secondary on agent bg"],
	["mutedFg", "agentBg", "muted on agent bg"],
	["mutedFg", "agentBg", "muted text on agent bg"],
];

const BODY_MIN = 4.5;
const SECONDARY_MIN = 1.5;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const [themeName, theme] of Object.entries(BUILT_IN_THEMES)) {
	// Only audit themes that have truecolor hex values — ANSI-16 has no reliable hex mapping.
	const hasTruecolor = [...BODY_PAIRS, ...SECONDARY_PAIRS].some(
		([fgKey, bgKey]) =>
			hexOf(theme[fgKey] as { truecolor?: string }) && hexOf(theme[bgKey] as { truecolor?: string }),
	);
	if (!hasTruecolor) continue;

	describe(`Theme: ${themeName}`, { tags: ["unit"] }, () => {
		for (const [fgKey, bgKey, label] of BODY_PAIRS) {
			const fg = hexOf(theme[fgKey] as { truecolor?: string });
			const bg = hexOf(theme[bgKey] as { truecolor?: string });
			if (!fg || !bg) continue;

			it(`body contrast ${label} >= ${BODY_MIN}:1`, () => {
				const ratio = contrast(fg, bg);
				expect(
					ratio,
					`${themeName} / ${label}: fg=${fg} bg=${bg} ratio=${ratio.toFixed(2)}:1 (need ${BODY_MIN}:1)`,
				).toBeGreaterThanOrEqual(BODY_MIN);
			});
		}

		for (const [fgKey, bgKey, label] of SECONDARY_PAIRS) {
			const fg = hexOf(theme[fgKey] as { truecolor?: string });
			const bg = hexOf(theme[bgKey] as { truecolor?: string });
			if (!fg || !bg) continue;

			it(`secondary contrast ${label} >= ${SECONDARY_MIN}:1`, () => {
				const ratio = contrast(fg, bg);
				expect(
					ratio,
					`${themeName} / ${label}: fg=${fg} bg=${bg} ratio=${ratio.toFixed(2)}:1 (need ${SECONDARY_MIN}:1)`,
				).toBeGreaterThanOrEqual(SECONDARY_MIN);
			});
		}
	});
}
