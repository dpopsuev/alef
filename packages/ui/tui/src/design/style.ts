/**
 * Composable style objects — declarative styling for TUI components.
 *
 * Prior art: Lip Gloss NewStyle().Foreground().Bold(),
 * Textual CSS, Ink <Text> props.
 *
 * Usage:
 *   const heading = style({ fg: { ansi16: 96 }, bold: true });
 *   const dimHeading = mergeStyles(heading, { dim: true });
 *   const rendered = applyStyle("Hello", heading);
 */

import { bold as ansiBold, color as ansiColor, dim as ansiDim, italic as ansiItalic, type ColorToken } from "../ansi.js";

/**
 *
 */
export interface Style {
	fg?: ColorToken;
	bg?: ColorToken;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	padding?: number;
}

/**
 *
 */
export function style(s: Style): Style {
	return s;
}

/**
 *
 */
export function mergeStyles(...styles: (Style | undefined)[]): Style {
	const result: Style = {};
	for (const s of styles) {
		if (!s) continue;
		if (s.fg !== undefined) result.fg = s.fg;
		if (s.bg !== undefined) result.bg = s.bg;
		if (s.bold !== undefined) result.bold = s.bold;
		if (s.dim !== undefined) result.dim = s.dim;
		if (s.italic !== undefined) result.italic = s.italic;
		if (s.padding !== undefined) result.padding = s.padding;
	}
	return result;
}

/**
 *
 */
export function applyStyle(text: string, s: Style): string {
	let result = text;
	if (s.fg) result = ansiColor(result, s.fg);
	if (s.bold) result = ansiBold(result);
	if (s.dim) result = ansiDim(result);
	if (s.italic) result = ansiItalic(result);
	if (s.padding) result = " ".repeat(s.padding) + result + " ".repeat(s.padding);
	return result;
}

/**
 *
 */
export function styleToFn(s: Style): (text: string) => string {
	return (text) => applyStyle(text, s);
}
