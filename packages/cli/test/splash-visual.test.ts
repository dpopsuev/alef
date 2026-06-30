/**
 * Visual test — run to see actual glyph rendering in the terminal.
 *
 *   cd packages/runner
 *   npx tsx ../../node_modules/vitest/dist/cli.js --run test/splash-visual.test.ts
 *
 * No assertions — prints rendered output for human inspection.
 */

import chalk from "chalk";
import { describe, it } from "vitest";
import { rasterise, rasterToBlocks } from "../src/client/splash/raster.js";

const LATIN_FONT = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const LATIN_BOLD = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf";
const HEBREW_FONT = "/usr/share/fonts/google-noto-vf/NotoSerifHebrew[wght].ttf";

const mag = chalk.magenta;

async function renderGlyph(glyph: string, fontPath: string, ptSize = 64): Promise<string> {
	const pixels = await rasterise(glyph, fontPath, ptSize);
	if (!pixels) return `(rasterise returned null for '${glyph}')`;
	return rasterToBlocks(
		pixels,
		(ch) => mag.bold(ch),
		(ch) => mag(ch),
		(ch) => mag.dim(ch),
	);
}

function section(label: string): void {
	process.stdout.write(`\n${chalk.bold(`── ${label} ${"─".repeat(40 - label.length)}`)}\n\n`);
}

describe("splash render — visual block elements", { tags: ["benchmark"] }, () => {
	it("renders Latin letters at 64pt", async () => {
		section("Latin 64pt — block elements");
		for (const ch of ["A", "B", "C", "H", "O", "8"]) {
			process.stdout.write(`  ${ch}:\n`);
			const art = await renderGlyph(ch, LATIN_FONT, 64);
			for (const line of art.split("\n")) process.stdout.write(`    ${line}\n`);
			process.stdout.write("\n");
		}
	});

	it("renders bold E vs regular E", async () => {
		section("Regular vs Bold E at 64pt");
		for (const [label, font] of [
			["Regular", LATIN_FONT],
			["Bold", LATIN_BOLD],
		] as const) {
			process.stdout.write(`  ${label}:\n`);
			const art = await renderGlyph("E", font, 64);
			for (const line of art.split("\n")) process.stdout.write(`    ${line}\n`);
			process.stdout.write("\n");
		}
	});

	it("renders Hebrew letters with NotoSerif at 64pt", async () => {
		section("Hebrew — NotoSerifHebrew 64pt");
		for (const ch of ["\u05d0", "\u05d1", "\u05d2", "\u05de", "\u05e9", "\u05ea"]) {
			process.stdout.write(`  ${ch}:\n`);
			const art = await renderGlyph(ch, HEBREW_FONT, 64);
			for (const line of art.split("\n")) process.stdout.write(`    ${line}\n`);
			process.stdout.write("\n");
		}
	});

	it("compares pt sizes for Hebrew alef", async () => {
		section("Hebrew \u05d0 at 32 / 64 / 96pt");
		for (const size of [32, 64, 96]) {
			process.stdout.write(`  ${size}pt:\n`);
			const art = await renderGlyph("\u05d0", HEBREW_FONT, size);
			for (const line of art.split("\n")) process.stdout.write(`    ${line}\n`);
			process.stdout.write("\n");
		}
	});

	it("prints raw darkness map for A", async () => {
		section("'A' raw pixel map (64pt)");
		const pixels = await rasterise("A", LATIN_FONT, 64);
		if (!pixels) {
			process.stdout.write("  null\n");
			return;
		}
		const SHADES = " .:-=+*#%@";
		for (const row of pixels) {
			process.stdout.write("  ");
			for (const v of row)
				process.stdout.write(SHADES[Math.min(SHADES.length - 1, Math.floor(v * SHADES.length))] ?? " ");
			process.stdout.write("\n");
		}
		process.stdout.write(`\n  (${pixels[0]?.length ?? 0}w × ${pixels.length}h px)\n`);
	});
});
