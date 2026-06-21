import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createCodeIntelOrgan } from "../src/organ.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

organComplianceSuite(() =>
	createCodeIntelOrgan({
		cwd: process.cwd(),
		backend: new StubCodeIntelBackend(),
	}),
);

describe("CodeIntelOrgan — tool surface", () => {
	it("exposes four LSP tools by default", () => {
		const organ = createCodeIntelOrgan({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
		});
		const names = organ.tools.map((t) => t.name).sort();
		expect(names).toEqual(["code.callers", "code.diagnose", "code.hover", "code.symbols"]);
	});

	it("ablation: actions allowlist restricts tools", () => {
		const organ = createCodeIntelOrgan({
			cwd: process.cwd(),
			backend: new StubCodeIntelBackend(),
			actions: ["code.symbols", "code.hover"],
		});
		const names = organ.tools.map((t) => t.name).sort();
		expect(names).toEqual(["code.hover", "code.symbols"]);
	});
});
