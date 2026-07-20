/**
 * Alef logo pipeline tests.
 * Start with a simple 3x3 grid, verify each stage of the pipeline,
 * then test the full Alef grid.
 */

import { describe, expect, it } from "vitest";
import { ALEF_GRID, renderAlefLogo, renderHalfBlocks, scale, shade, shadow } from "../src/client/alef-logo.js";

const SIMPLE_3X3 = [
	[1, 1, 1],
	[1, 1, 1],
	[1, 1, 1],
];

describe("alef-logo pipeline", { tags: ["unit"] }, () => {
	describe("scale", () => {
		it("1x returns the same grid", () => {
			expect(scale(SIMPLE_3X3, 1)).toEqual(SIMPLE_3X3);
		});

		it("2x doubles each dimension", () => {
			const result = scale(SIMPLE_3X3, 2);
			expect(result.length).toBe(6);
			expect(result[0]!.length).toBe(6);
			// Solid 3x3 scaled 2x -> every pixel is 1
			for (let y = 0; y < 6; y++) {
				for (let x = 0; x < 6; x++) {
					expect(result[y]![x]).toBe(1);
				}
			}
		});

		it("preserves pixel values", () => {
			const result = scale(
				[
					[1, 0],
					[0, 1],
				],
				3,
			);
			expect(result.length).toBe(6);
			expect(result[0]!.length).toBe(6);
			// All pixels in the (0,0) block should be 1
			for (let y = 0; y < 3; y++) {
				for (let x = 0; x < 3; x++) {
					expect(result[y]![x]).toBe(1);
				}
			}
			// All pixels in the (0,1) block should be 0
			for (let y = 0; y < 3; y++) {
				for (let x = 3; x < 6; x++) {
					expect(result[y]![x]).toBe(0);
				}
			}
		});
	});

	describe("shade", () => {
		it("adds shade column after right edge of each run", () => {
			const input = [[1, 1, 0]];
			const result = shade(input, 1);
			expect(result[0]).toEqual([1, 1, 2, 0]);
		});

		it("does not overwrite existing foreground", () => {
			const input = [[1, 1, 1]];
			const result = shade(input, 1);
			// Shade goes after the last pixel
			expect(result[0]).toEqual([1, 1, 1, 2]);
		});

		it("shades each run independently", () => {
			const input = [[1, 0, 1]];
			const result = shade(input, 1);
			// Run at col 0 gets shade at col 1, run at col 2 gets shade at col 3
			expect(result[0]).toEqual([1, 2, 1, 2]);
		});

		it("supports multi-column shade depth", () => {
			const input = [[1, 0, 0, 0]];
			const result = shade(input, 3);
			expect(result[0]).toEqual([1, 2, 2, 2, 0, 0, 0]);
		});

		it("does not shade empty rows", () => {
			const input = [[0, 0, 0]];
			const result = shade(input, 1);
			expect(result[0]).toEqual([0, 0, 0, 0]);
		});
	});

	describe("shadow", () => {
		it("adds shadow columns after rightmost non-empty cell", () => {
			const input = [[1, 2, 0, 0]];
			const result = shadow(input, 2);
			// Rightmost non-empty is col 1 (shade). Shadow at col 2, 3.
			expect(result[0]).toEqual([1, 2, 3, 3, 0, 0]);
		});

		it("does not overwrite foreground or shade", () => {
			const input = [[1, 2, 1, 0]];
			const result = shadow(input, 2);
			// Rightmost non-empty is col 2 (fg). Shadow at col 3, 4.
			expect(result[0]).toEqual([1, 2, 1, 3, 3, 0]);
		});

		it("handles fully filled row", () => {
			const input = [[1, 1, 1]];
			const result = shadow(input, 2);
			// Shadow goes after the end
			expect(result[0]).toEqual([1, 1, 1, 3, 3]);
		});

		it("handles empty row", () => {
			const input = [[0, 0, 0]];
			const result = shadow(input, 2);
			expect(result[0]).toEqual([0, 0, 0, 0, 0]);
		});
	});

	describe("renderHalfBlocks", () => {
		it("renders solid block for two fg rows", () => {
			const grid = [[1], [1]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2588"]);
		});

		it("renders upper half for fg-top empty-bottom", () => {
			const grid = [[1], [0]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2580"]);
		});

		it("renders lower half for empty-top fg-bottom", () => {
			const grid = [[0], [1]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2584"]);
		});

		it("renders shade char for shade values", () => {
			const grid = [[2], [2]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2593"]);
		});

		it("renders shadow char for shadow values", () => {
			const grid = [[3], [3]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2591"]);
		});

		it("renders space for empty", () => {
			const grid = [[0], [0]];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual([]);
		});

		it("handles odd row count", () => {
			const grid = [[1], [1], [1]];
			const lines = renderHalfBlocks(grid);
			expect(lines.length).toBe(2);
			expect(lines[0]).toBe("\u2588");
			expect(lines[1]).toBe("\u2580");
		});

		it("strips trailing blank lines", () => {
			const grid = [
				[1, 0],
				[1, 0],
				[0, 0],
				[0, 0],
			];
			const lines = renderHalfBlocks(grid);
			expect(lines).toEqual(["\u2588"]);
		});
	});

	describe("full pipeline on 3x3", () => {
		it("scale then shade then shadow produces expected dimensions", () => {
			let grid = scale(SIMPLE_3X3, 2);
			expect(grid.length).toBe(6);
			expect(grid[0]!.length).toBe(6);

			grid = shade(grid, 1);
			expect(grid[0]!.length).toBe(7);

			grid = shadow(grid, 2);
			expect(grid[0]!.length).toBe(9);
		});

		it("renderHalfBlocks compresses vertical dimension by 2", () => {
			let grid = scale(SIMPLE_3X3, 2);
			grid = shade(grid, 1);
			grid = shadow(grid, 2);
			const lines = renderHalfBlocks(grid);
			expect(lines.length).toBeLessThanOrEqual(4);
			expect(lines.length).toBeGreaterThan(0);
		});
	});

	describe("ALEF_GRID", () => {
		it("is 5x5", () => {
			expect(ALEF_GRID.length).toBe(5);
			for (const row of ALEF_GRID) {
				expect(row.length).toBe(5);
			}
		});

		it("has 13 filled pixels", () => {
			const total = ALEF_GRID.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
			expect(total).toBe(13);
		});

		it("is connected (single cluster via diagonal adjacency)", () => {
			const h = ALEF_GRID.length;
			const w = ALEF_GRID[0]!.length;
			const visited = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
			const flood = (r: number, c: number): number => {
				if (r < 0 || r >= h || c < 0 || c >= w) return 0;
				if (visited[r]![c]! || !ALEF_GRID[r]![c]) return 0;
				visited[r]![c] = true;
				let count = 1;
				for (let dr = -1; dr <= 1; dr++) {
					for (let dc = -1; dc <= 1; dc++) {
						if (dr === 0 && dc === 0) continue;
						count += flood(r + dr, c + dc);
					}
				}
				return count;
			};
			// Start from first filled pixel
			let started = false;
			let clusterSize = 0;
			for (let r = 0; r < h && !started; r++) {
				for (let c = 0; c < w && !started; c++) {
					if (ALEF_GRID[r]![c]) {
						clusterSize = flood(r, c);
						started = true;
					}
				}
			}
			expect(clusterSize).toBe(13);
		});
	});

	describe("renderAlefLogo", () => {
		it("produces non-empty output at default scale", () => {
			const lines = renderAlefLogo();
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.some((l) => l.includes("\u2588"))).toBe(true);
		});

		it("produces wider output at higher scale", () => {
			const s3 = renderAlefLogo(3);
			const s5 = renderAlefLogo(5);
			const maxW3 = Math.max(...s3.map((l) => l.length));
			const maxW5 = Math.max(...s5.map((l) => l.length));
			expect(maxW5).toBeGreaterThan(maxW3);
		});

		it("includes shade and shadow characters", () => {
			const lines = renderAlefLogo(5, 1, 2);
			const all = lines.join("");
			expect(all).toContain("\u2593");
			expect(all).toContain("\u2591");
		});

		it("output matches snapshot at 5x scale", () => {
			const lines = renderAlefLogo(5, 1, 2);
			expect(lines).toMatchSnapshot();
		});
	});
});
