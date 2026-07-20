/**
 * Alef logo pipeline: atomic grid -> scale -> shade -> shadow -> half-block render.
 *
 * Each stage is a pure function operating on a 2D number grid.
 * Grid values: 0=empty, 1=foreground, 2=shade(▓), 3=shadow(░).
 */

/** The 5x5 atomic Hebrew Alef. */
export const ALEF_GRID = [
	[1, 0, 0, 1, 1],
	[0, 1, 0, 0, 1],
	[1, 0, 1, 0, 1],
	[1, 0, 0, 1, 0],
	[1, 1, 0, 0, 1],
];

/** Nearest-neighbor scale a binary grid by an integer factor. */
export function scale(grid: number[][], factor: number): number[][] {
	const h = grid.length;
	const w = grid[0]?.length ?? 0;
	return Array.from({ length: h * factor }, (_, y) =>
		Array.from({ length: w * factor }, (_, x) => grid[Math.floor(y / factor)]![Math.floor(x / factor)]!),
	);
}

/**
 * Add right-edge shading (value 2) to each foreground run.
 * Appends `depth` shade columns after each right edge of a filled run.
 */
export function shade(grid: number[][], depth = 1): number[][] {
	const h = grid.length;
	const w = grid[0]?.length ?? 0;
	const out = grid.map((row) => [...row, ...Array.from<number>({ length: depth }).fill(0)]);
	const ow = w + depth;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (grid[y]![x] === 1 && (x + 1 >= w || grid[y]![x + 1] !== 1)) {
				for (let d = 0; d < depth; d++) {
					const sx = x + 1 + d;
					if (sx < ow && out[y]![sx] === 0) {
						out[y]![sx] = 2;
					}
				}
			}
		}
	}
	return out;
}

/**
 * Add right-edge shadow (value 3) after existing shading.
 * Appends `depth` shadow columns after each rightmost non-empty cell of a run.
 */
export function shadow(grid: number[][], depth = 2): number[][] {
	const h = grid.length;
	const w = grid[0]?.length ?? 0;
	const out = grid.map((row) => [...row, ...Array.from<number>({ length: depth }).fill(0)]);
	const ow = w + depth;
	for (let y = 0; y < h; y++) {
		for (let x = w - 1; x >= 0; x--) {
			if (grid[y]![x]! > 0 && (x + 1 >= w || grid[y]![x + 1] === 0)) {
				for (let d = 0; d < depth; d++) {
					const sx = x + 1 + d;
					if (sx < ow && out[y]![sx] === 0) {
						out[y]![sx] = 3;
					}
				}
				break;
			}
		}
	}
	return out;
}

/**
 * Render a multi-value grid to terminal lines using half-block characters.
 * Pairs of vertical pixels become one character row using ▀▄█ and shade/shadow glyphs.
 */
export function renderHalfBlocks(grid: number[][]): string[] {
	const h = grid.length;
	const w = grid[0]?.length ?? 0;
	const charMap: Record<number, string> = { 0: " ", 1: "\u2588", 2: "\u2593", 3: "\u2591" };
	const lines: string[] = [];

	for (let y = 0; y < h; y += 2) {
		let line = "";
		for (let x = 0; x < w; x++) {
			const t = grid[y]?.[x] ?? 0;
			const b = grid[y + 1]?.[x] ?? 0;

			if (t === b) {
				line += charMap[t] ?? " ";
			} else if (t === 1 && b === 0) {
				line += "\u2580";
			} else if (t === 0 && b === 1) {
				line += "\u2584";
			} else if (t === 1) {
				line += "\u2580";
			} else if (b === 1) {
				line += "\u2584";
			} else if (t === 2 || b === 2) {
				line += "\u2593";
			} else if (t === 3 || b === 3) {
				line += "\u2591";
			} else {
				line += " ";
			}
		}
		lines.push(line.replace(/\s+$/, ""));
	}

	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
		lines.pop();
	}
	return lines;
}

/** Full pipeline: atomic grid -> scale -> shade -> shadow -> half-block lines. */
export function renderAlefLogo(factor = 5, shadeDepth = 1, shadowDepth = 2): string[] {
	let grid = scale(ALEF_GRID, factor);
	grid = shade(grid, shadeDepth);
	grid = shadow(grid, shadowDepth);
	return renderHalfBlocks(grid);
}
