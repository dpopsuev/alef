/**
 * TreeSitterBackend integration tests.
 *
 * Tests tree-sitter parsing for TypeScript and Python.
 */

import { describe, expect, it } from "vitest";
import { TreeSitterBackend } from "../src/tree-sitter-backend.js";

describe("TreeSitterBackend", { tags: ["unit"] }, () => {
	const backend = new TreeSitterBackend();

	describe("language detection", () => {
		it("detects TypeScript files", () => {
			expect(backend.detectLanguage("src/foo.ts")).toBe("typescript");
			expect(backend.detectLanguage("src/Component.tsx")).toBe("typescript");
		});

		it("detects JavaScript files", () => {
			expect(backend.detectLanguage("src/foo.js")).toBe("javascript");
			expect(backend.detectLanguage("src/App.jsx")).toBe("javascript");
			expect(backend.detectLanguage("index.mjs")).toBe("javascript");
			expect(backend.detectLanguage("config.cjs")).toBe("javascript");
		});

		it("detects Python files", () => {
			expect(backend.detectLanguage("app.py")).toBe("python");
			expect(backend.detectLanguage("tests/test_main.py")).toBe("python");
		});

		it("returns null for unsupported files", () => {
			expect(backend.detectLanguage("README.md")).toBeNull();
			expect(backend.detectLanguage("data.json")).toBeNull();
		});
	});

	describe("TypeScript parsing", () => {
		it("parses simple TypeScript code", async () => {
			const code = `
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
			const tree = await backend.parse(code, "typescript");
			expect(tree.rootNode.type).toBe("program");
			expect(tree.rootNode.childCount).toBeGreaterThan(0);
		});

		it("extracts function declarations", async () => {
			const code = `
function add(a: number, b: number): number {
  return a + b;
}

function multiply(x: number, y: number) {
  return x * y;
}
`;
			const tree = await backend.parse(code, "typescript");
			const symbols = backend.extractSymbols(tree, code, "typescript");

			expect(symbols).toHaveLength(2);
			expect(symbols[0]).toMatchObject({
				name: "add",
				kind: "function",
				startLine: 2,
			});
			expect(symbols[1]).toMatchObject({
				name: "multiply",
				kind: "function",
				startLine: 6,
			});
		});

		it("extracts class declarations", async () => {
			const code = `
class Person {
  constructor(public name: string) {}
  
  greet() {
    return \`Hello, I'm \${this.name}\`;
  }
}

class Animal {
  speak() {
    console.log("...");
  }
}
`;
			const tree = await backend.parse(code, "typescript");
			const symbols = backend.extractSymbols(tree, code, "typescript");

			const classes = symbols.filter((s) => s.kind === "class");
			expect(classes).toHaveLength(2);
			expect(classes[0]).toMatchObject({
				name: "Person",
				kind: "class",
				startLine: 2,
			});
			expect(classes[1]).toMatchObject({
				name: "Animal",
				kind: "class",
				startLine: 10,
			});
		});

		it("extracts interface declarations", async () => {
			const code = `
interface User {
  id: number;
  name: string;
}

interface Post {
  title: string;
  content: string;
}
`;
			const tree = await backend.parse(code, "typescript");
			const symbols = backend.extractSymbols(tree, code, "typescript");

			expect(symbols).toHaveLength(2);
			expect(symbols[0]).toMatchObject({
				name: "User",
				kind: "interface",
				startLine: 2,
			});
			expect(symbols[1]).toMatchObject({
				name: "Post",
				kind: "interface",
				startLine: 7,
			});
		});

		it("extracts type aliases", async () => {
			const code = `
type Status = "active" | "inactive";
type ID = string | number;
`;
			const tree = await backend.parse(code, "typescript");
			const symbols = backend.extractSymbols(tree, code, "typescript");

			expect(symbols).toHaveLength(2);
			expect(symbols[0]).toMatchObject({
				name: "Status",
				kind: "type",
			});
			expect(symbols[1]).toMatchObject({
				name: "ID",
				kind: "type",
			});
		});

		it("extracts const declarations", async () => {
			const code = `
const PI = 3.14159;
const greeting = "Hello";
let counter = 0;
`;
			const tree = await backend.parse(code, "typescript");
			const symbols = backend.extractSymbols(tree, code, "typescript");

			expect(symbols.length).toBeGreaterThanOrEqual(2);
			const constSymbols = symbols.filter((s) => s.kind === "const");
			expect(constSymbols.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe.skip("Python parsing - TODO: fix version compat", () => {
		it("parses simple Python code", async () => {
			const code = `
def greet(name):
    return f"Hello, {name}!"
`;
			const tree = await backend.parse(code, "python");
			expect(tree.rootNode.type).toBe("module");
			expect(tree.rootNode.childCount).toBeGreaterThan(0);
		});

		it("extracts function definitions", async () => {
			const code = `
def add(a, b):
    return a + b

def multiply(x, y):
    return x * y

def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b
`;
			const tree = await backend.parse(code, "python");
			const symbols = backend.extractSymbols(tree, code, "python");

			expect(symbols).toHaveLength(3);
			expect(symbols[0]).toMatchObject({
				name: "add",
				kind: "function",
				startLine: 2,
			});
			expect(symbols[1]).toMatchObject({
				name: "multiply",
				kind: "function",
				startLine: 5,
			});
			expect(symbols[2]).toMatchObject({
				name: "divide",
				kind: "function",
				startLine: 8,
			});
		});

		it("extracts class definitions", async () => {
			const code = `
class Person:
    def __init__(self, name):
        self.name = name
    
    def greet(self):
        return f"Hello, I'm {self.name}"

class Animal:
    def speak(self):
        print("...")
`;
			const tree = await backend.parse(code, "python");
			const symbols = backend.extractSymbols(tree, code, "python");

			const classes = symbols.filter((s) => s.kind === "class");
			expect(classes).toHaveLength(2);
			expect(classes[0]).toMatchObject({
				name: "Person",
				kind: "class",
				startLine: 2,
			});
			expect(classes[1]).toMatchObject({
				name: "Animal",
				kind: "class",
				startLine: 9,
			});
		});

		it("extracts nested functions within classes", async () => {
			const code = `
class Calculator:
    def add(self, a, b):
        return a + b
    
    def subtract(self, a, b):
        return a - b
`;
			const tree = await backend.parse(code, "python");
			const symbols = backend.extractSymbols(tree, code, "python");

			// Should extract the class and its methods
			expect(symbols.length).toBeGreaterThanOrEqual(1);
			const classSymbol = symbols.find((s) => s.name === "Calculator");
			expect(classSymbol).toBeDefined();
			expect(classSymbol?.kind).toBe("class");
		});
	});

	describe("AST node conversion", () => {
		it.skip("converts tree-sitter nodes to ASTNode format - uses JS", async () => {
			const code = `function add(a, b) { return a + b; }`;
			const tree = await backend.parse(code, "javascript");
			const astNode = backend.getASTNode(tree, code, 2);

			expect(astNode.type).toBe("program");
			expect(astNode.startLine).toBe(1);
			expect(astNode.children).toBeDefined();
			expect(astNode.children!.length).toBeGreaterThan(0);
		});

		it("respects maxDepth parameter", async () => {
			const code = `
class Foo {
  bar() {
    if (true) {
      return 42;
    }
  }
}
`;
			const tree = await backend.parse(code, "typescript");

			// Depth 1 - just the root
			const shallow = backend.getASTNode(tree, code, 1);
			expect(shallow.children).toBeDefined();
			expect(shallow.children!.every((c) => !c.children || c.children.length === 0)).toBe(true);

			// Depth 3 - more nested structure
			const deep = backend.getASTNode(tree, code, 3);
			expect(deep.children).toBeDefined();
			const hasNestedChildren = deep.children!.some((c) => c.children && c.children.some((gc) => gc.children));
			expect(hasNestedChildren).toBe(true);
		});
	});
});
