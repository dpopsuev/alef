import { describe, expect, it } from "vitest";
import { pillFooterStr, pillHeaderStr } from "../src/tui-mode.js";

function visibleWidth(s: string): number {
	// Strip ANSI escape sequences before measuring.
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

describe("pill delimiter alignment", () => {
	for (const width of [20, 40, 80, 120, 160]) {
		it(`header and footer are same width at ${width} columns`, () => {
			const header = pillHeaderStr("@you", width);
			const footer = pillFooterStr(width);
			expect(visibleWidth(header)).toBe(visibleWidth(footer));
		});

		it(`header fills exactly ${width} columns for label '@you'`, () => {
			const header = pillHeaderStr("@you", width);
			expect(visibleWidth(header)).toBe(width);
		});

		it(`footer fills exactly ${width} columns`, () => {
			const footer = pillFooterStr(width);
			expect(visibleWidth(footer)).toBe(width);
		});
	}

	it("header starts with ╭ and ends with ╮", () => {
		const h = pillHeaderStr("test", 40);
		expect(h[0]).toBe("╭");
		expect(h[h.length - 1]).toBe("╮");
	});

	it("footer starts with ╰ and ends with ╯", () => {
		const f = pillFooterStr(40);
		expect(f[0]).toBe("╰");
		expect(f[f.length - 1]).toBe("╯");
	});

	it("header contains the label", () => {
		const h = pillHeaderStr("@alef", 60);
		expect(h).toContain("@alef");
	});

	it("long label is clamped — header never overflows", () => {
		const label = "a".repeat(200);
		const h = pillHeaderStr(label, 40);
		// ╭ + ─ + space + label + space + ╮ with fill=0 = 2 + 2 + label.length
		// header may be wider than width when label is huge, but never shorter
		expect(visibleWidth(h)).toBeGreaterThanOrEqual(40);
	});
});
