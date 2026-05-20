// Pure rendering pipeline — rasterise a glyph to a grayscale map,
// then shade it into Braille characters. No side effects, fully testable.

// ---------------------------------------------------------------------------
// Grayscale rasteriser
// Returns darkness per pixel: 0.0 = white/empty, 1.0 = black ink.
// ---------------------------------------------------------------------------

export async function rasterise(glyph: string, fontPath: string, ptSize: number): Promise<number[][] | null> {
	try {
		const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
		GlobalFonts.registerFromPath(fontPath, "__SplashFont__");

		// Measure to get exact glyph bounds.
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
				// Use only the red channel — canvas renders black ink on white background.
				const darkness = 1 - (data[(y * w + x) * 4] ?? 255) / 255;
				if (darkness > 0.15) totalInk++;
				return darkness;
			}),
		);

		return totalInk < 20 ? null : pixels;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Braille shading with Bayer ordered dithering
//
// Braille dot layout (2 cols × 4 rows per terminal cell → U+2800):
//   col 0  col 1
//   0x01   0x08   row 0
//   0x02   0x10   row 1
//   0x04   0x20   row 2
//   0x40   0x80   row 3
//
// Bayer 2×4 threshold matrix — each dot fires when its pixel's darkness
// exceeds the positional threshold. Produces smooth antialiased edges
// rather than hard binary cutoffs.
// ---------------------------------------------------------------------------

const BRAILLE_BIT: readonly (readonly number[])[] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

const BAYER_2X4: readonly (readonly number[])[] = [
	[0 / 8, 4 / 8],
	[2 / 8, 6 / 8],
	[1 / 8, 5 / 8],
	[3 / 8, 7 / 8],
];

/**
 * Convert a grayscale darkness map to shaded Braille art.
 *
 * Three ANSI intensity levels are applied based on average cell darkness:
 *   high   (avg > 0.55) → boldFg  — solid stroke core
 *   medium (avg > 0.20) → fg      — mid stroke
 *   low    (avg > 0.05) → dimFg   — faint antialiased edge
 *
 * Pass raw ANSI escape strings for each level, e.g.:
 *   boldFg = "\x1b[1m\x1b[35m"
 *   fg     = "\x1b[35m"
 *   dimFg  = "\x1b[2m\x1b[35m"
 *   reset  = "\x1b[0m"
 */
export function rasterToShaded(
	pixels: readonly (readonly number[])[],
	boldFg: string,
	fg: string,
	dimFg: string,
	reset: string,
): string {
	const H = pixels.length;
	const W = pixels[0]?.length ?? 0;
	const lines: string[] = [];

	for (let cellY = 0; cellY * 4 < H; cellY++) {
		let line = "";

		for (let cellX = 0; cellX * 2 < W; cellX++) {
			// Average darkness of the 2×4 cell — selects intensity level.
			let sum = 0;
			let count = 0;
			for (let dr = 0; dr < 4; dr++) {
				for (let dc = 0; dc < 2; dc++) {
					const py = cellY * 4 + dr;
					const px = cellX * 2 + dc;
					if (py < H && px < W) {
						sum += pixels[py]?.[px] ?? 0;
						count++;
					}
				}
			}
			const avg = count > 0 ? sum / count : 0;

			if (avg < 0.05) {
				line += "  ";
				continue;
			}

			// Bayer dithering: set a dot when its pixel's darkness exceeds
			// the positional threshold. Gives smooth sub-cell antialiasing.
			let mask = 0;
			for (let dr = 0; dr < 4; dr++) {
				for (let dc = 0; dc < 2; dc++) {
					const py = cellY * 4 + dr;
					const px = cellX * 2 + dc;
					const darkness = py < H && px < W ? (pixels[py]?.[px] ?? 0) : 0;
					if (darkness > (BAYER_2X4[dr]?.[dc] ?? 0)) {
						mask |= BRAILLE_BIT[dr]?.[dc] ?? 0;
					}
				}
			}

			const ch = String.fromCodePoint(0x2800 | mask);
			const prefix = avg > 0.55 ? boldFg : avg > 0.2 ? fg : dimFg;
			line += `${prefix}${ch}${reset}`;
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
