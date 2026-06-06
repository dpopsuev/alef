/**
 * Tests for TUI layout constants and ANSI sanitization.
 */

import { describe, expect, it } from "vitest";
import { sanitizeForDisplay, stripAnsi } from "../src/tui/ansi-utils.js";
import { INDENT, SPACING } from "../src/tui/layout-constants.js";

describe("Layout Constants", { tags: ["unit"] }, () => {
	it("defines block indent", () => {
		expect(INDENT.BLOCK).toBe(2);
	});

	it("defines tool line indent", () => {
		expect(INDENT.TOOL_LINE).toBe(2);
	});

	it("defines tool output indent", () => {
		expect(INDENT.TOOL_OUTPUT).toBe(3);
	});

	it("defines spacing between blocks", () => {
		expect(SPACING.BETWEEN_BLOCKS).toBe(1);
	});
});

describe("ANSI Utilities", { tags: ["unit"] }, () => {
	it("strips ANSI color codes", () => {
		const input = "\x1b[1mBold\x1b[0m text";
		expect(stripAnsi(input)).toBe("Bold text");
	});

	it("strips multiple ANSI codes", () => {
		const input = "\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m";
		expect(stripAnsi(input)).toBe("Red Green");
	});

	it("preserves text without ANSI codes", () => {
		const input = "Plain text";
		expect(stripAnsi(input)).toBe("Plain text");
	});

	it("sanitizes for display: strips ANSI and normalizes line endings", () => {
		const input = "\x1b[1mBold\x1b[0m\r\nline2";
		expect(sanitizeForDisplay(input)).toBe("Bold\nline2");
	});

	it("removes null bytes", () => {
		const input = "text\0with\0nulls";
		expect(sanitizeForDisplay(input)).toBe("textwithnulls");
	});
});
