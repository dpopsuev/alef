import { describe, expect, it } from "vitest";
import { formatError } from "../src/errors.js";

describe("formatError", () => {
	it("formats timeout errors", () => {
		const msg = formatError(new Error("DialogOrgan.send timed out after 120000ms"));
		expect(msg).toContain("[error]");
		expect(msg).toContain("timed out");
		expect(msg).not.toContain("120000");
	});

	it("formats rate limit errors", () => {
		const msg = formatError(new Error("429 Too Many Requests"));
		expect(msg).toContain("[error]");
		expect(msg).toContain("Rate limited");
	});

	it("formats unknown errors with original message", () => {
		const msg = formatError(new Error("some unexpected failure"));
		expect(msg).toBe("[error] some unexpected failure");
	});

	it("handles non-Error values", () => {
		const msg = formatError("plain string error");
		expect(msg).toBe("[error] plain string error");
	});

	it("always starts with [error]", () => {
		for (const e of [
			new Error("timed out"),
			new Error("429"),
			new Error("rate limit exceeded"),
			new Error("context too long"),
			new Error("anything else"),
			"raw string",
		]) {
			expect(formatError(e)).toMatch(/^\[error\]/);
		}
	});
});
