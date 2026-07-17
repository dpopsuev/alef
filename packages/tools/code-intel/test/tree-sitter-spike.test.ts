/**
 * Tree-sitter spike tests - minimal proof of concept.
 * Demonstrates tree-sitter integration works for TypeScript.
 */

import { describe, expect, it } from "vitest";
import { TreeSitterBackend } from "../src/tree-sitter-backend.js";

describe("TreeSitterBackend - Spike", { tags: ["unit"] }, () => {
	const backend = new TreeSitterBackend();

	it("parses TypeScript and extracts functions", async () => {
		const code = `
function add(a: number, b: number): number {
  return a + b;
}

class Calculator {
  multiply(x: number, y: number) {
    return x * y;
  }
}
`;
		const tree = await backend.parse(code, "typescript");
		const symbols = backend.extractSymbols(tree, code, "typescript");

		expect(symbols.length).toBeGreaterThanOrEqual(2);
		const func = symbols.find((s) => s.name === "add");
		const cls = symbols.find((s) => s.name === "Calculator");

		expect(func).toBeDefined();
		expect(func?.kind).toBe("function");
		expect(cls).toBeDefined();
		expect(cls?.kind).toBe("class");
	});

	it("detects language from file extension", () => {
		expect(backend.detectLanguage("src/foo.ts")).toBe("typescript");
		expect(backend.detectLanguage("app.jsx")).toBe("javascript");
		expect(backend.detectLanguage("unknown.txt")).toBeNull();
	});

	it("converts AST nodes", async () => {
		const code = `function test() { return 42; }`;
		const tree = await backend.parse(code, "typescript");
		const astNode = backend.getASTNode(tree, code, 2);

		expect(astNode.type).toBe("program");
		expect(astNode.children).toBeDefined();
		expect(astNode.children!.length).toBeGreaterThan(0);
	});
});
