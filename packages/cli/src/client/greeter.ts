const MIN_GLYPH_INK_PIXELS = 20;
/** Render a single glyph to a 2D pixel-darkness grid using a system font. */
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

/** Trim empty columns from the left and right edges of a pixel grid. */
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

/**
 * Convert a pixel-darkness grid into half-block lines.
 * When no style callbacks are provided, returns plain (unstyled) characters.
 */
export function rasterToLines(
	pixels: readonly (readonly number[])[],
	dense?: (ch: string) => string,
	mid?: (ch: string) => string,
	faint?: (ch: string) => string,
): string[] {
	const identity = (ch: string): string => ch;
	const d = dense ?? identity;
	const m = mid ?? identity;
	const f = faint ?? identity;

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
				ch = "\u2588"; // full
			else if (topOn)
				ch = "\u2580"; // upper
			else if (botOn)
				ch = "\u2584"; // lower
			else if (avg > 0.25)
				ch = "\u2593"; // dark shade
			else if (avg > 0.15)
				ch = "\u2592"; // medium shade
			else ch = "\u2591"; // light shade

			const style = avg > 0.5 ? d : avg > 0.2 ? m : f;
			line += style(ch);
		}

		lines.push(line);
	}

	// Strip leading and trailing blank lines.
	let start = 0;
	let end = lines.length - 1;
	while (start <= end && lines[start]?.trim() === "") start++;
	while (end >= start && lines[end]?.trim() === "") end--;

	return lines.slice(start, end + 1);
}

/** Convert a pixel-darkness grid into a styled Unicode block string for terminal display. */
export function rasterToBlocks(
	pixels: readonly (readonly number[])[],
	dense: (ch: string) => string,
	mid: (ch: string) => string,
	faint: (ch: string) => string,
): string {
	return rasterToLines(pixels, dense, mid, faint).join("\n");
}
