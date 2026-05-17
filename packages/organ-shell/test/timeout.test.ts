import { describe, expect, it } from "vitest";
import { DEFAULT_SHELL_TIMEOUT_S, MAX_SHELL_TIMEOUT_S } from "../src/organ.js";

describe("shell timeout constants", () => {
	it("default timeout is 120s", () => {
		expect(DEFAULT_SHELL_TIMEOUT_S).toBe(120);
	});

	it("max timeout cap is 600s", () => {
		expect(MAX_SHELL_TIMEOUT_S).toBe(600);
	});
});

describe("shell timeout clamping (via organ motor event)", () => {
	it("exports are correct types", () => {
		expect(typeof DEFAULT_SHELL_TIMEOUT_S).toBe("number");
		expect(typeof MAX_SHELL_TIMEOUT_S).toBe("number");
		expect(DEFAULT_SHELL_TIMEOUT_S).toBeGreaterThan(0);
		expect(MAX_SHELL_TIMEOUT_S).toBeGreaterThan(DEFAULT_SHELL_TIMEOUT_S);
	});
});
