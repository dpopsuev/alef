import { describe, expect, it } from "vitest";
import { formatError } from "../src/errors.js";

// formatError returns the human-readable message only.
// Call sites are responsible for adding any [error] prefix — see tui-mode.ts.

describe("formatError", () => {
	it("formats timeout errors", () => {
		const msg = formatError(new Error("AgentController.send timed out after 120000ms"));
		expect(msg).toContain("timed out");
		expect(msg).not.toContain("120000");
	});

	it("formats rate limit errors", () => {
		const msg = formatError(new Error("429 Too Many Requests"));
		expect(msg).toContain("Rate limited");
	});

	it("formats unknown errors with original message", () => {
		// Temporarily unset ALEF_DEBUG to test the base behavior
		// In debug mode, formatErrorForUser appends stack traces
		const originalDebug = process.env.ALEF_DEBUG;
		delete process.env.ALEF_DEBUG;

		const msg = formatError(new Error("some unexpected failure"));
		expect(msg).toBe("some unexpected failure");

		// Restore
		if (originalDebug !== undefined) {
			process.env.ALEF_DEBUG = originalDebug;
		}
	});

	it("handles non-Error values", () => {
		const msg = formatError("plain string error");
		expect(msg).toBe("plain string error");
	});

	it("never returns an empty string", () => {
		for (const e of [
			new Error("timed out"),
			new Error("429"),
			new Error("rate limit exceeded"),
			new Error("context too long"),
			new Error("anything else"),
			"raw string",
		]) {
			expect(formatError(e).length).toBeGreaterThan(0);
		}
	});

	it("includes stack trace when ALEF_DEBUG=1", () => {
		const originalDebug = process.env.ALEF_DEBUG;
		process.env.ALEF_DEBUG = "1";

		const msg = formatError(new Error("debug mode error"));
		expect(msg).toContain("debug mode error");
		expect(msg).toContain("Error: debug mode error"); // Stack trace included
		expect(msg.split("\n").length).toBeGreaterThan(1); // Multi-line

		// Restore
		if (originalDebug !== undefined) {
			process.env.ALEF_DEBUG = originalDebug;
		} else {
			delete process.env.ALEF_DEBUG;
		}
	});
});
