import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { afterAll, describe, expect, it } from "vitest";
import { createCodeIntelAdapter } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

const complianceCwd = mkdtempSync(join(tmpdir(), "code-intel-compliance-"));
writeFileSync(join(complianceCwd, "sample.ts"), "export function sample() { return 1; }\n");

afterAll(() => {
	rmSync(complianceCwd, { recursive: true, force: true });
});

adapterComplianceSuite(() =>
	createCodeIntelAdapter({
		cwd: complianceCwd,
		backend: new StubCodeIntelBackend(),
		graphDbPath: join(complianceCwd, "graph.db"),
	}),
);

describe("CodeIntelAdapter — tool surface", () => {
	it("exposes LSP, AST, and graph tools by default", () => {
		const adapter = createCodeIntelAdapter({
			cwd: complianceCwd,
			backend: new StubCodeIntelBackend(),
			graphDbPath: join(complianceCwd, "surface.db"),
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
			"code.index",
			"code.references",
			"code.review",
			"code.symbols",
		]);
	});

	it("ablation: actions allowlist restricts tools", () => {
		const adapter = createCodeIntelAdapter({
			cwd: complianceCwd,
			backend: new StubCodeIntelBackend(),
			graphDbPath: join(complianceCwd, "ablate.db"),
			actions: ["code.symbols", "code.hover"],
		});
		const names = adapter.tools.map((t) => t.name).sort();
		expect(names).toEqual(["code.hover", "code.symbols"]);
	});
});
