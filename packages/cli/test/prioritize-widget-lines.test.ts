import { describe, expect, it } from "vitest";
import { prioritizeWidgetLines } from "../src/client/console.js";

describe("prioritizeWidgetLines", { tags: ["unit"] }, () => {
	it("keeps header and active block when truncating", () => {
		const lines = [
			"Plan · working on 1 · 0/10 done",
			"  ○ early step one here",
			"  ○ early step two here",
			"  ● active step label here  ◄",
			"      gate · file-exists: a",
			"  ○ later step three here",
			"  ○ later step four here",
			"  ○ later step five here",
		];
		const out = prioritizeWidgetLines(lines, 5);
		expect(out[0]).toContain("Plan ·");
		expect(out.some((line) => line.includes("active step"))).toBe(true);
		expect(out.some((line) => line.includes("gate ·"))).toBe(true);
		expect(out.at(-1)).toMatch(/… \d+ more/);
	});

	it("passes through when under the cap", () => {
		const lines = ["Plan · no steps yet", "  ○ only step label here"];
		expect(prioritizeWidgetLines(lines, 5)).toEqual(lines);
	});
});
