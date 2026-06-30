const MIN_GLYPH_INK_PIXELS = 20;
const FONT_LOAD_TIMEOUT_MS = 2000;
const GLYPH_PT_SIZE = 20;
export async function rasterise(glyph: string, fontPath: string, ptSize: number): Promise<number[][] | null> {
	try {
		const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
		GlobalFonts.registerFromPath(fontPath, "__SplashFont__");

		const probe = createCanvas(1, 1);
		const pctx = probe.getContext("2d");
		pctx.font = `${ptSize}px __SplashFont__`;
		const metrics = pctx.measureText(glyph);
		const w = Math.ceil(metrics.width) + 4;
		const h = ptSize + 8;
		if (w <= 4) return null;

		const canvas = createCanvas(w, h);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "black";
		ctx.font = `${ptSize}px __SplashFont__`;
		ctx.fillText(glyph, 2, ptSize - 2);

		const data = ctx.getImageData(0, 0, w, h).data;
		let totalInk = 0;
		const pixels = Array.from({ length: h }, (_, y) =>
			Array.from({ length: w }, (_, x) => {
				const darkness = 1 - (data[(y * w + x) * 4] ?? 255) / 255;
				if (darkness > 0.15) totalInk++;
				return darkness;
			}),
		);

		return totalInk < MIN_GLYPH_INK_PIXELS ? null : pixels;
	} catch {
		return null;
	}
}

export function cropColumns(pixels: readonly (readonly number[])[]): readonly (readonly number[])[] {
	const H = pixels.length;
	const W = pixels[0]?.length ?? 0;

	let left = W;
	let right = -1;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			if ((pixels[y]?.[x] ?? 0) > 0.05) {
				if (x < left) left = x;
				if (x > right) right = x;
			}
		}
	}

	if (left > right) return pixels;
	return pixels.map((row) => row.slice(left, right + 1));
}

//
//

export function rasterToBlocks(
	pixels: readonly (readonly number[])[],
	dense: (ch: string) => string,
	mid: (ch: string) => string,
	faint: (ch: string) => string,
): string {
	const cropped = cropColumns(pixels);
	const H = cropped.length;
	const W = cropped[0]?.length ?? 0;
	const lines: string[] = [];

	for (let cellY = 0; cellY * 2 < H; cellY++) {
		let line = "";

		for (let cellX = 0; cellX < W; cellX++) {
			const top = cropped[cellY * 2]?.[cellX] ?? 0;
			const bot = cropped[cellY * 2 + 1]?.[cellX] ?? 0;
			const avg = (top + bot) / 2;

			if (avg < 0.06) {
				line += " ";
				continue;
			}

			const topOn = top > 0.35;
			const botOn = bot > 0.35;

			let ch: string;
			if (topOn && botOn)
				ch = "\u2588"; // █
			else if (topOn)
				ch = "\u2580"; // ▀
			else if (botOn)
				ch = "\u2584"; // ▄
			else if (avg > 0.25)
				ch = "\u2593"; // ▓
			else if (avg > 0.15)
				ch = "\u2592"; // ▒
			else ch = "\u2591"; // ░

			const style = avg > 0.5 ? dense : avg > 0.2 ? mid : faint;
			line += style(ch);
		}

		lines.push(line);
	}

	// Strip leading and trailing blank lines.
	let start = 0;
	let end = lines.length - 1;
	while (start <= end && lines[start]?.trim() === "") start++;
	while (end >= start && lines[end]?.trim() === "") end--;

	return lines.slice(start, end + 1).join("\n");
}

// ALEF_NO_SPLASH=1 disables the splash.

import { execSync } from "node:child_process";
import { getConfig } from "../boot/config.js";
import { chalkForToken, getTheme, systemLang } from "./theme.js";

interface ScriptBlock {
	lang: string;
	name: string;
	start: number;
	end: number;
}

const BLOCKS: readonly ScriptBlock[] = [
	{ lang: "ja", name: "Hiragana", start: 0x3041, end: 0x3096 },
	{ lang: "ja", name: "Katakana", start: 0x30a1, end: 0x30f6 },
	{ lang: "zh", name: "CJK", start: 0x4e00, end: 0x9fff },
	{ lang: "ko", name: "Hangul", start: 0xac00, end: 0xd7a3 },
	{ lang: "hi", name: "Devanagari", start: 0x0904, end: 0x0939 },
	{ lang: "ar", name: "Arabic", start: 0x0621, end: 0x063a },
	{ lang: "he", name: "Hebrew", start: 0x05d0, end: 0x05ea },
	{ lang: "th", name: "Thai", start: 0x0e01, end: 0x0e2e },
	{ lang: "ka", name: "Georgian", start: 0x10d0, end: 0x10fa },
	{ lang: "am", name: "Ethiopic", start: 0x1200, end: 0x1376 },
	{ lang: "el", name: "Greek", start: 0x03b1, end: 0x03c9 },
	{ lang: "hy", name: "Armenian", start: 0x0531, end: 0x0556 },
	{ lang: "ru", name: "Cyrillic", start: 0x0410, end: 0x042f },
	{ lang: "ta", name: "Tamil", start: 0x0b85, end: 0x0bb9 },
	{ lang: "bo", name: "Tibetan", start: 0x0f40, end: 0x0f6c },
	{ lang: "my", name: "Myanmar", start: 0x1000, end: 0x1021 },
	{ lang: "km", name: "Khmer", start: 0x1780, end: 0x17a2 },
	{ lang: "si", name: "Sinhala", start: 0x0d85, end: 0x0dc6 },
	{ lang: "te", name: "Telugu", start: 0x0c05, end: 0x0c39 },
	{ lang: "kn", name: "Kannada", start: 0x0c85, end: 0x0cb9 },
];

export function randomCodePoint(block: ScriptBlock): string {
	const cp = Math.floor(Math.random() * (block.end - block.start + 1)) + block.start;
	return String.fromCodePoint(cp);
}

function installedLangs(): Set<string> {
	const langs = new Set<string>();
	try {
		const out = execSync("fc-list --format='%{lang}\\n'", {
			timeout: FONT_LOAD_TIMEOUT_MS,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const line of out.split("\n")) {
			for (const tag of line.split("|")) {
				const code = tag.trim().split("-")[0].toLowerCase();
				if (code) langs.add(code);
			}
		}
	} catch {
		/* fc-list unavailable */
	}
	return langs;
}

function fontPathForLang(lang: string): string | null {
	try {
		const out = execSync(`fc-list :lang=${lang} --format='%{file}\\n'`, {
			timeout: FONT_LOAD_TIMEOUT_MS,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const files = out
			.split("\n")
			.map((l) => l.trim())
			.filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"));
		// Prefer Noto / Google fonts over bitmap/terminal fonts (Terminus, etc.)
		/* eslint-disable @typescript-eslint/no-unnecessary-condition -- find() can return undefined; array index may be out of bounds */
		return (
			files.find((f) => /noto/i.test(f)) ??
			files.find((f) => !/terminus|terminess|nerd/i.test(f)) ??
			files[0] ??
			null
		);
		/* eslint-enable @typescript-eslint/no-unnecessary-condition */
	} catch {
		return null;
	}
}

export function buildPool(): ScriptBlock[] {
	const langs = installedLangs();
	const available = BLOCKS.filter((b) => langs.has(b.lang));
	const pool = available.length > 0 ? available : BLOCKS.slice(0, 5);

	const preferredLang = process.env.ALEF_SPLASH_LANG ?? getConfig().splash?.lang ?? systemLang();
	const preferred = pool.find((b) => b.lang === preferredLang);
	return preferred ? [preferred, ...pool.filter((b) => b !== preferred)] : pool;
}

let _cached: string | null = null;

export async function renderSplash(): Promise<string> {
	if (process.env.ALEF_NO_SPLASH === "1") return "";
	if (_cached !== null) return _cached;

	const tokenChalk = chalkForToken(getTheme().accentFg);
	const pool = buildPool();

	for (let attempt = 0; attempt < 8; attempt++) {
		const block = attempt === 0 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard: pool index may be out of bounds
		if (!block) continue;

		const fontPath = fontPathForLang(block.lang);
		if (!fontPath) continue;

		const pixels = await rasterise(randomCodePoint(block), fontPath, GLYPH_PT_SIZE);
		if (!pixels) continue;

		const art = rasterToBlocks(
			pixels,
			(ch) => tokenChalk.bold(ch),
			(ch) => tokenChalk(ch),
			(ch) => tokenChalk.dim(ch),
		);
		if (!art.trim()) continue;

		_cached = art;
		return _cached;
	}

	_cached = "";
	return _cached;
}
