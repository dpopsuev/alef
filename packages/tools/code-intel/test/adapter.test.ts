import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createCodeIntelAdapter } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

adapterComplianceSuite(() =>
	createCodeIntelAdapter({
		cwd: process.cwd(),
		backend: new StubCodeIntelBackend(),
	}),
);

describe("CodeIntelAdapter — tool surface", () => {
	it("exposes ten tools by default", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		const names = adapter.tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"code.ast.extract",
			"code.ast.match",
			"code.callers",
			"code.dependencies",
			"code.diagnose",
			"code.hover",
			"code.impact",
			"code.references",
			"code.review",
			"code.symbols",
		]);
	});

	it("ablation: actions allowlist restricts tools", () => {
		const adapter = createCodeIntelAdapter({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
			actions: ["code.symbols", "code.hover"],
		});
		const names = adapter.tools.map((t) => t.name).sort();
		expect(names).toEqual(["code.hover", "code.symbols"]);
	});
});
