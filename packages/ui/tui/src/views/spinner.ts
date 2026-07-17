import chalk from "chalk";
import type { ColorToken } from "../ansi.js";
import { color, colorDepth } from "../ansi.js";

/** Stable braille spinners — no script-letter pools (Hebrew/CJK) in chrome. */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

let counter = 0;
const indexMap = new Map<string, number>();

/**
 *
 */
function indexFor(id: string): number {
	let idx = indexMap.get(id);
	if (idx === undefined) {
		idx = counter++;
		indexMap.set(id, idx);
	}
	return idx;
}

/**
 *
 */
function hueShiftColorize(token: ColorToken, hueDeg: number): (text: string) => string {
	if (colorDepth() !== "truecolor" || !token.truecolor) {
		return (text) => color(text, token);
	}
	const hex = token.truecolor.replace("#", "");
	const r0 = parseInt(hex.slice(0, 2), 16) / 255;
	const g0 = parseInt(hex.slice(2, 4), 16) / 255;
	const b0 = parseInt(hex.slice(4, 6), 16) / 255;
	const vv = Math.max(r0, g0, b0);
	const d = vv - Math.min(r0, g0, b0);
	const ss = vv === 0 ? 0 : d / vv;
	let hh = 0;
	if (d > 0) {
		if (vv === r0) hh = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6;
		else if (vv === g0) hh = ((b0 - r0) / d + 2) / 6;
		else hh = ((r0 - g0) / d + 4) / 6;
	}
	const nh = (hh + hueDeg / 360) % 1;
	const i = Math.floor(nh * 6);
	const f = nh * 6 - i;
	const p = vv * (1 - ss);
	const q = vv * (1 - f * ss);
	const t2 = vv * (1 - (1 - f) * ss);
	const sectors: [number, number, number][] = [
		[vv, t2, p],
		[q, vv, p],
		[p, vv, t2],
		[p, q, vv],
		[t2, p, vv],
		[vv, p, q],
	];
	const [fr, fg2, fb] = sectors[i % 6] ?? [vv, vv, vv];
	return (text) => chalk.rgb(Math.round(fr * 255), Math.round(fg2 * 255), Math.round(fb * 255))(text);
}

/**
 *
 */
function hueToAnsi256(hue: number): number {
	const h = ((hue % 360) + 360) % 360;
	const sector = Math.floor(h / 60);
	const f = (h % 60) / 60;
	const colors = [196, 208, 226, 46, 51, 201];
	return Math.round(colors[sector % 6]! + (colors[(sector + 1) % 6]! - colors[sector % 6]!) * f);
}

/**
 *
 */
export function spinnerFrame(id: string, elapsedMs: number): string {
	const idx = indexFor(id);
	const frameIdx = (Math.floor(elapsedMs / 80) + idx) % BRAILLE_FRAMES.length;
	const hue = ((idx * 137) % 360) + ((elapsedMs / 50) % 360);
	return chalk.ansi256(hueToAnsi256(hue))(BRAILLE_FRAMES[frameIdx]!);
}

/**
 *
 */
export function accentColorize(token: ColorToken, elapsedMs: number): (text: string) => string {
	return hueShiftColorize(token, (elapsedMs / 20) % 360);
}
