import { describe, expect, it } from "vitest";
import { createCodeIntelAdapter } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

describe("code.review tool", () => {
	it("is registered in the adapter's tool list", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		const names = adapter.tools.map((t) => t.name);
		expect(names).toContain("code.review");
	});

	it("tool count is now 5 (symbols, hover, callers, diagnose, review)", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		expect(adapter.tools.length).toBe(5);
	});
});
