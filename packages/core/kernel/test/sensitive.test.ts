import { describe, expect, it } from "vitest";
import { isSensitive, REDACTED, reveal, Sensitive } from "../src/sensitive.js";

describe("Sensitive", { tags: ["unit"] }, () => {
	it("isSensitive detects markers only", () => {
		expect(isSensitive(Sensitive("x"))).toBe(true);
		expect(isSensitive({ value: "x" })).toBe(false);
		expect(isSensitive("x")).toBe(false);
	});

	it("reveal unwraps markers", () => {
		expect(reveal(Sensitive(42))).toBe(42);
		expect(reveal(7)).toBe(7);
	});

	it("JSON.stringify uses toJSON redaction", () => {
		expect(JSON.stringify(Sensitive("leak"))).toBe(`"${REDACTED}"`);
	});
});
