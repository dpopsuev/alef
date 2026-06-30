import { formatErrorForUser } from "@dpopsuev/alef-kernel/errors";
import { describe, expect, it } from "vitest";

// formatErrorForUser returns the human-readable message only.
// Call sites are responsible for adding any [error] prefix — see tui-mode.ts.

describe("formatErrorForUser", () => {
	it("formats timeout errors", () => {
		const msg = formatErrorForUser(new Error("AgentController.send timed out after 120000ms"));
		expect(msg).toContain("timed out");
		expect(msg).not.toContain("120000");
	});

	it("formats rate limit errors", () => {
		const msg = formatErrorForUser(new Error("429 Too Many Requests"));
		expect(msg).toContain("Rate limited");
	});

	it("formats unknown errors with original message", () => {
		// Temporarily unset ALEF_DEBUG to test the base behavior
		// In debug mode, formatErrorForUserForUser appends stack traces
		const originalDebug = process.env.ALEF_DEBUG;
		delete process.env.ALEF_DEBUG;

		const msg = formatErrorForUser(new Error("some unexpected failure"));
		expect(msg).toBe("some unexpected failure");

		// Restore
		if (originalDebug !== undefined) {
			process.env.ALEF_DEBUG = originalDebug;
		}
	});

	it("handles non-Error values", () => {
		const msg = formatErrorForUser("plain string error");
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
			expect(formatErrorForUser(e).length).toBeGreaterThan(0);
		}
	});

	it("includes stack trace when ALEF_DEBUG=1", () => {
		const originalDebug = process.env.ALEF_DEBUG;
		process.env.ALEF_DEBUG = "1";

		const msg = formatErrorForUser(new Error("debug mode error"));
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
