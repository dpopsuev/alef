import { describe, expect, it } from "vitest";
import { createCodeIntelOrgan } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

describe("code.review tool", () => {
	it("is registered in the organ's tool list", () => {
		const organ = createCodeIntelOrgan({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("code.review");
	});

	it("tool count is now 5 (symbols, hover, callers, diagnose, review)", () => {
		const organ = createCodeIntelOrgan({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		expect(organ.tools.length).toBe(5);
	});
});
