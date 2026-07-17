/**
 * AST outline - minimal test.
 */

import { describe, expect, it } from "vitest";
import { TreeSitterBackend } from "../src/tree-sitter-backend.js";

describe("code.ast.outline", { tags: ["unit"] }, () => {
	it("generates outline from TypeScript", async () => {
		const backend = new TreeSitterBackend();
		const code = `
export function greet() {}
export class User {}
export interface IUser {}
`;
		const tree = await backend.parse(code, "typescript");
		const symbols = backend.extractSymbols(tree, code, "typescript");

		expect(symbols.length).toBe(3);
		const kinds = symbols.map((s) => s.kind);
		expect(kinds).toContain("function");
		expect(kinds).toContain("class");
		expect(kinds).toContain("interface");
	});
});
