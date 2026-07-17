import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodeIntelAdapter } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

describe("code.review tool", () => {
	it("is registered in the adapter's tool list", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
			graphDbPath: join(tmpdir(), `code-intel-review-${process.pid}.db`),
		});
		const names = adapter.tools.map((t) => t.name);
		expect(names).toContain("code.review");
	});

	it("exposes LSP, AST, and graph tools", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
			graphDbPath: join(tmpdir(), `code-intel-review-${process.pid}.db`),
		});
		const names = new Set(adapter.tools.map((tool) => tool.name));
		for (const name of [
			"code.symbols",
			"code.hover",
			"code.callers",
			"code.diagnose",
			"code.review",
			"code.ast.match",
			"code.ast.extract",
			"code.index",
			"code.dependencies",
			"code.references",
			"code.impact",
		]) {
			expect(names.has(name)).toBe(true);
		}
		expect(adapter.tools.length).toBe(11);
	});
});

