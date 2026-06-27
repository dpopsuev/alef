/**
 * glyph() type safety — verifies the compile-time + runtime fix.
 *
 * Before fix: glyph("state:batch") threw "Cannot read properties of
 * undefined (reading 'ascii')" because state:batch was missing from
 * the GLYPHS map. This killed the TUI rendering during parallel tool
 * call completion, causing the "thinking but no response" hang.
 *
 * After fix: GLYPHS uses `satisfies` and glyph() takes GlyphKey union
 * type. TypeScript catches unknown keys at compile time. state:batch
 * is now in the map.
 */

import { describe, expect, it } from "vitest";
import { glyph } from "../src/views/theme.js";

describe("glyph() type safety", { tags: ["unit"] }, () => {
	it("state:batch returns a glyph (was the crash site)", () => {
		const result = glyph("state:batch");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("all known keys return non-empty strings", () => {
		const keys = [
			"state:done", "state:active", "state:error", "state:pending",
			"state:pruned", "state:deferred", "state:current", "state:batch",
			"user", "bullet", "sep", "dot",
		] as const;

		for (const key of keys) {
			const result = glyph(key);
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		}
	});

	// Unknown keys are now a compile-time error:
	// glyph("nonexistent") → TypeScript error TS2345
	// This test can't call glyph with a bad key because TS won't allow it.
});
