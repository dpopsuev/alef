/**
 * Spinner stability -- color must not change on every tick.
 *
 * The flicker bug: accentColorize and spinnerFrame produced different ANSI
 * colors on every call because hue rotated based on raw elapsedMs.
 * At 28ms tick intervals, the color changed ~35 times/sec, causing flicker.
 *
 * Fix: quantize elapsedMs to 200ms steps for hue calculation.
 * The braille character still rotates at 80ms, but color holds steady.
 */

import { describe, expect, it } from "vitest";
import { accentColorize, spinnerFrame } from "../src/views/spinner.js";

describe("spinnerFrame color stability", { tags: ["unit"] }, () => {
	it("rapid 28ms ticks produce at most 3 distinct outputs per 196ms", () => {
		const outputs = new Set<string>();
		for (let i = 0; i < 7; i++) {
			outputs.add(spinnerFrame("test", 1000 + i * 28));
		}
		expect(
			outputs.size,
			`expected at most 3 distinct outputs (braille only), got ${outputs.size}`,
		).toBeLessThanOrEqual(3);
	});
});

describe("accentColorize stability", { tags: ["unit"] }, () => {
	it("produces the same color within a 200ms window", () => {
		const token = { truecolor: "#6488ff", ansi256: 69, ansi16: 34 };
		const outputs = new Set<string>();
		for (let ms = 1000; ms < 1200; ms += 20) {
			outputs.add(accentColorize(token, ms)("test"));
		}
		expect(
			outputs.size,
			`expected 1 distinct output within 200ms, got ${outputs.size}`,
		).toBe(1);
	});

	it("does NOT produce a unique color on every 28ms tick", () => {
		const token = { truecolor: "#6488ff", ansi256: 69, ansi16: 34 };
		const outputs = new Set<string>();
		for (let i = 0; i < 7; i++) {
			outputs.add(accentColorize(token, 1000 + i * 28)("test"));
		}
		expect(outputs.size, "should produce exactly 1 color within 196ms").toBe(1);
	});
});
