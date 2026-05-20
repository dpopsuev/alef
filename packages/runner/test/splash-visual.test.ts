/**
 * Visual test — run to see actual glyph rendering in the terminal.
 *
 *   cd packages/runner
 *   npx tsx ../../node_modules/vitest/dist/cli.js --run test/splash-visual.test.ts
 *
 * This test never asserts — it prints rendered output so a human can judge
 * whether the Braille shading looks correct.
 */

import { describe, it } from "vitest";
import { rasterise, rasterToShaded } from "../src/splash-render.js";

const LATIN_FONT = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const LATIN_BOLD = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf";
const HEBREW_FONT = "/usr/share/fonts/terminus-fonts/TerminessNerdFontPropo-Regular.ttf";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG_MAG = "\x1b[35m"; // magenta — representative terminal theme color

async function renderGlyph(glyph: string, fontPath: string, ptSize = 64): Promise<string> {
	const pixels = await rasterise(glyph, fontPath, ptSize);
	if (!pixels) return `(rasterise returned null for '${glyph}')`;
	return rasterToShaded(pixels, `${BOLD}${FG_MAG}`, FG_MAG, `${DIM}${FG_MAG}`, RESET);
}

function printDivider(label: string): void {
	process.stdout.write(`\n${BOLD}── ${label} ${"─".repeat(40 - label.length)}${RESET}\n\n`);
}

describe("splash render — visual", () => {
	it("renders Latin letters A B C H I O at different sizes", async () => {
		for (const size of [32, 64, 96]) {
			printDivider(`Latin ${size}pt`);
			for (const ch of ["A", "B", "C", "H", "I", "O"]) {
				process.stdout.write(`  ${ch}:\n`);
				const art = await renderGlyph(ch, LATIN_FONT, size);
				for (const line of art.split("\n")) {
					process.stdout.write(`    ${line}\n`);
				}
				process.stdout.write("\n");
			}
		}
	});

	it("renders bold vs regular — stroke weight comparison", async () => {
		printDivider("Regular vs Bold at 64pt");
		for (const [label, font] of [
			["Regular", LATIN_FONT],
			["Bold", LATIN_BOLD],
		] as const) {
			process.stdout.write(`  ${label}:\n`);
			const art = await renderGlyph("E", font, 64);
			for (const line of art.split("\n")) {
				process.stdout.write(`    ${line}\n`);
			}
			process.stdout.write("\n");
		}
	});

	it("renders Hebrew alef at 64pt", async () => {
		printDivider("Hebrew \u05d0 (alef) 64pt");
		const art = await renderGlyph("\u05d0", HEBREW_FONT, 64);
		for (const line of art.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
		process.stdout.write("\n");
	});

	it("renders digit 8 — symmetry check", async () => {
		printDivider("Digit 8 — symmetry check");
		const art = await renderGlyph("8", LATIN_FONT, 64);
		for (const line of art.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
		process.stdout.write("\n");
	});

	it("prints raw pixel map for 'I' — debugging aid", async () => {
		printDivider("'I' raw darkness map (64pt)");
		const pixels = await rasterise("I", LATIN_FONT, 64);
		if (!pixels) {
			process.stdout.write("  null\n");
			return;
		}

		const SHADES = " .:-=+*#%@";
		for (const row of pixels) {
			process.stdout.write("  ");
			for (const v of row) {
				const idx = Math.min(SHADES.length - 1, Math.floor(v * SHADES.length));
				process.stdout.write(SHADES[idx] ?? " ");
			}
			process.stdout.write("\n");
		}
		process.stdout.write(`\n  (${pixels[0]?.length ?? 0}w × ${pixels.length}h px)\n`);
	});
});
