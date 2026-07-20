/**
 * Gradient utilities for terminal color rendering.
 * Pure functions -- no theme or TUI dependencies.
 */

/** RGB color tuple. */
export type Rgb = [number, number, number];

const RESET = "\x1b[0m";

/** Clamp a color channel to 0-255. */
export function clamp(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}

/** Darken an RGB color by a fraction (0-1). */
export function darken(rgb: Rgb, amount: number): Rgb {
	return [clamp(rgb[0] * (1 - amount)), clamp(rgb[1] * (1 - amount)), clamp(rgb[2] * (1 - amount))];
}

/** Lighten an RGB color by a fraction (0-1). */
export function lighten(rgb: Rgb, amount: number): Rgb {
	return [
		clamp(rgb[0] + (255 - rgb[0]) * amount),
		clamp(rgb[1] + (255 - rgb[1]) * amount),
		clamp(rgb[2] + (255 - rgb[2]) * amount),
	];
}

/** Build a cosine-wave palette of `steps` colors around an accent color. */
export function buildPalette(accent: Rgb, steps: number, maxDarken: number, maxLighten: number): Rgb[] {
	return Array.from({ length: steps }, (_, i) => {
		const wave = -Math.cos((i / steps) * Math.PI * 2);
		return wave < 0 ? darken(accent, maxDarken * -wave) : lighten(accent, maxLighten * wave);
	});
}

/** Sample a color from the palette with linear interpolation. Position wraps at 1.0. */
export function sample(palette: Rgb[], pos: number): Rgb {
	const p = ((pos % 1) + 1) % 1;
	const scaled = p * palette.length;
	const base = Math.floor(scaled) % palette.length;
	const next = (base + 1) % palette.length;
	const f = scaled - Math.floor(scaled);
	const a = palette[base]!;
	const b = palette[next]!;
	return [
		Math.round(a[0] + (b[0] - a[0]) * f),
		Math.round(a[1] + (b[1] - a[1]) * f),
		Math.round(a[2] + (b[2] - a[2]) * f),
	];
}

/** Render a line of text with per-character gradient coloring. Spaces are left unstyled. */
export function gradientLine(text: string, palette: Rgb[], phase: number): string {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars
		.map((ch, i) => {
			if (ch === " ") return " ";
			const [r, g, b] = sample(palette, i / span + phase);
			return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
		})
		.join("");
}

/** Parse a hex color string (#RRGGBB or RRGGBB) to RGB. Returns null on invalid input. */
export function hexToRgb(hex: string): Rgb | null {
	const clean = hex.replace("#", "");
	if (clean.length !== 6) return null;
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
	return [r, g, b];
}
