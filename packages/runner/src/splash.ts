// ALEF_NO_SPLASH=1 disables the splash.

import { execSync } from "node:child_process";
import { BOLD, getTheme, RESET } from "./theme.js";

// ---------------------------------------------------------------------------
// Script block registry — Unicode ranges known to be predominantly letters.
// Ranges deliberately avoid leading diacritics / combining marks.
// ---------------------------------------------------------------------------

interface ScriptBlock {
	lang: string; // fc-list lang tag
	name: string;
	start: number; // first code point (inclusive)
	end: number; // last code point (inclusive)
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

function randomCodePoint(block: ScriptBlock): string {
	const cp = Math.floor(Math.random() * (block.end - block.start + 1)) + block.start;
	return String.fromCodePoint(cp);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function installedLangs(): Set<string> {
	const langs = new Set<string>();
	try {
		const out = execSync("fc-list --format='%{lang}\\n'", {
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const line of out.split("\n")) {
			for (const lang of line.split("|")) {
				const code = lang.trim().split("-")[0].toLowerCase();
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
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const files = out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		return files.find((f) => f.endsWith(".ttf") || f.endsWith(".otf")) ?? files[0] ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Braille encoding — 2×4 pixel grid per cell → U+2800
//
// Dot layout:
//   col0  col1
//    1     4    row 0
//    2     5    row 1
//    3     6    row 2
//    7     8    row 3
// ---------------------------------------------------------------------------

const BRAILLE_BITS: readonly (readonly [number, number])[] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

function imageToBraille(pixels: readonly (readonly boolean[])[], fgAnsi: string): string {
	const H = pixels.length;
	const W = pixels[0]?.length ?? 0;
	const lines: string[] = [];

	for (let cellY = 0; cellY * 4 < H; cellY++) {
		let line = "";
		for (let cellX = 0; cellX * 2 < W; cellX++) {
			let mask = 0;
			let anyLit = false;
			for (let dotRow = 0; dotRow < 4; dotRow++) {
				const py = cellY * 4 + dotRow;
				if (py >= H) break;
				for (let dotCol = 0; dotCol < 2; dotCol++) {
					const px = cellX * 2 + dotCol;
					if (px >= W) break;
					if (pixels[py]?.[px]) {
						mask |= BRAILLE_BITS[dotRow]?.[dotCol] ?? 0;
						anyLit = true;
					}
				}
			}
			if (!anyLit) {
				line += "  ";
				continue;
			}
			const ch = String.fromCodePoint(0x2800 | mask);
			line += `${BOLD}${fgAnsi}${ch}${RESET}`;
		}
		lines.push(line);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function rasterise(glyph: string, fontPath: string, ptSize: number): Promise<boolean[][] | null> {
	try {
		const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
		GlobalFonts.registerFromPath(fontPath, "SplashFont");

		const measure = createCanvas(1, 1);
		const mctx = measure.getContext("2d");
		mctx.font = `${ptSize}px SplashFont`;
		const metrics = mctx.measureText(glyph);
		const w = Math.ceil(metrics.width) + 4;
		const h = ptSize + 8;
		if (w <= 4) return null; // font doesn't cover this glyph

		const canvas = createCanvas(w, h);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "black";
		ctx.font = `${ptSize}px SplashFont`;
		ctx.fillText(glyph, 2, ptSize - 2);

		const data = ctx.getImageData(0, 0, w, h).data;
		const pixels: boolean[][] = [];
		let totalLit = 0;
		for (let y = 0; y < h; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < w; x++) {
				const lit = (data[(y * w + x) * 4] ?? 255) < 128;
				row.push(lit);
				if (lit) totalLit++;
			}
			pixels.push(row);
		}

		// Reject if the glyph rendered as a tofu box or is empty
		if (totalLit < 20) return null;
		return pixels;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

let _cached: string | null = null;

export async function renderSplash(): Promise<string> {
	if (process.env.ALEF_NO_SPLASH === "1") return "";
	if (_cached !== null) return _cached;

	const t = getTheme();
	const hex = t.accentFg.truecolor.replace("#", "");
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	const blossom = `\x1b[38;2;${r};${g};${b}m`;

	const langs = installedLangs();
	const available = BLOCKS.filter((s) => langs.has(s.lang));
	const pool = available.length > 0 ? available : BLOCKS.slice(0, 5);

	for (let attempt = 0; attempt < 8; attempt++) {
		const block = pool[Math.floor(Math.random() * pool.length)];
		if (!block) continue;

		const glyph = randomCodePoint(block);
		const fontPath = fontPathForLang(block.lang);
		if (!fontPath) continue;

		const pixels = await rasterise(glyph, fontPath, 48);
		if (!pixels) continue;

		const art = imageToBraille(pixels, blossom);
		if (!art.trim()) continue;

		_cached = art;
		return _cached;
	}

	_cached = "";
	return _cached;
}
