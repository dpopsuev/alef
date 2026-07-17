/**
 * AST tools tests.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASTTools } from "../src/ast-tools.js";

describe("ASTTools", { tags: ["unit"] }, () => {
	it("matches symbols by pattern", async () => {
		const tools = new ASTTools();
		const tmpDir = mkdtempSync(join(tmpdir(), "ast-test-"));

		// Create test file
		writeFileSync(
			join(tmpDir, "test.ts"),
			`
function calculateSum(a: number, b: number) {
  return a + b;
}

class Calculator {
  add(x: number, y: number) {
    return x + y;
  }
}
`
		);

		const results = await tools.match({
			pattern: "calc*",
			path: tmpDir,
		});

		expect(results.length).toBeGreaterThan(0);
		const names = results.map((r) => r.symbol.name);
		expect(names).toContain("calculateSum");
		expect(names).toContain("Calculator");
	});

	it("extracts symbol definition", async () => {
		const tools = new ASTTools();
		const tmpDir = mkdtempSync(join(tmpdir(), "ast-test-"));

		writeFileSync(
			join(tmpDir, "test.ts"),
			`
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`
		);

		const result = await tools.extract({
			symbol: "greet",
			path: join(tmpDir, "test.ts"),
		});

		expect(result).toBeDefined();
		expect(result?.symbol.name).toBe("greet");
		expect(result?.symbol.kind).toBe("function");
		expect(result?.fullText).toContain("greet");
	});

	it("filters by symbol kind", async () => {
		const tools = new ASTTools();
		const tmpDir = mkdtempSync(join(tmpdir(), "ast-test-"));

		writeFileSync(
			join(tmpDir, "test.ts"),
			`
function myFunc() {}
class MyClass {}
interface MyInterface {}
`
		);

		const results = await tools.match({
			pattern: "my*",
			path: tmpDir,
			kind: "class",
		});

		expect(results.length).toBe(1);
		expect(results[0]?.symbol.name).toBe("MyClass");
	});
});
