// ALEF_NO_SPLASH=1 disables the splash.

import { execSync } from "node:child_process";
import { getConfig } from "./config.js";
import { rasterise, rasterToBlocks } from "./splash-render.js";
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

function randomCodePoint(block: ScriptBlock): string {
	const cp = Math.floor(Math.random() * (block.end - block.start + 1)) + block.start;
	return String.fromCodePoint(cp);
}

function installedLangs(): Set<string> {
	const langs = new Set<string>();
	try {
		const out = execSync("fc-list --format='%{lang}\\n'", {
			timeout: 2000,
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
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const files = out
			.split("\n")
			.map((l) => l.trim())
			.filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"));
		// Prefer Noto / Google fonts over bitmap/terminal fonts (Terminus, etc.)
		return (
			files.find((f) => /noto/i.test(f)) ??
			files.find((f) => !/terminus|terminess|nerd/i.test(f)) ??
			files[0] ??
			null
		);
	} catch {
		return null;
	}
}

function buildPool(): ScriptBlock[] {
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
		if (!block) continue;

		const fontPath = fontPathForLang(block.lang);
		if (!fontPath) continue;

		const pixels = await rasterise(randomCodePoint(block), fontPath, 20);
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
