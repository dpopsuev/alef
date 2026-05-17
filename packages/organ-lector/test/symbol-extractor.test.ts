import { describe, expect, it } from "vitest";
import { extractBlock, extractSymbols } from "../src/symbol-extractor.js";

const TS_SOURCE = `
export function add(a: number, b: number): number {
  return a + b;
}

export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(\`/users/\${id}\`);
  return res.json();
}

export class AuthService {
  private token: string = "";

  login(username: string, password: string): boolean {
    this.token = btoa(\`\${username}:\${password}\`);
    return true;
  }

  logout(): void {
    this.token = "";
  }
}

export interface Config {
  host: string;
  port: number;
}

export type Status = "active" | "inactive" | "pending";

export const MAX_RETRIES = 3;

export const createClient = (url: string) => {
  return { url };
};

function internalHelper(): void {}

class InternalClass {}
`.trim();

describe("extractSymbols", () => {
	it("extracts exported functions", () => {
		const symbols = extractSymbols(TS_SOURCE);
		const names = symbols.map((s) => s.name);
		expect(names).toContain("add");
		expect(names).toContain("fetchUser");
	});

	it("marks exported symbols correctly", () => {
		const symbols = extractSymbols(TS_SOURCE);
		expect(symbols.find((s) => s.name === "add")?.exported).toBe(true);
		expect(symbols.find((s) => s.name === "internalHelper")?.exported).toBe(false);
	});

	it("extracts class and its methods", () => {
		const symbols = extractSymbols(TS_SOURCE);
		expect(symbols.find((s) => s.name === "AuthService")?.kind).toBe("class");
		expect(symbols.find((s) => s.name === "login")?.kind).toBe("method");
		expect(symbols.find((s) => s.name === "logout")?.kind).toBe("method");
	});

	it("extracts interface", () => {
		const symbols = extractSymbols(TS_SOURCE);
		const iface = symbols.find((s) => s.name === "Config");
		expect(iface?.kind).toBe("interface");
		expect(iface?.exported).toBe(true);
	});

	it("extracts type alias", () => {
		const symbols = extractSymbols(TS_SOURCE);
		const t = symbols.find((s) => s.name === "Status");
		expect(t?.kind).toBe("type");
	});

	it("extracts const declaration", () => {
		const symbols = extractSymbols(TS_SOURCE);
		expect(symbols.find((s) => s.name === "MAX_RETRIES")?.kind).toBe("const");
		expect(symbols.find((s) => s.name === "createClient")?.kind).toBe("const");
	});

	it("extracts non-exported class", () => {
		const symbols = extractSymbols(TS_SOURCE);
		const c = symbols.find((s) => s.name === "InternalClass");
		expect(c?.kind).toBe("class");
		expect(c?.exported).toBe(false);
	});

	it("assigns startLine > 0 for each symbol", () => {
		const symbols = extractSymbols(TS_SOURCE);
		for (const s of symbols) {
			expect(s.startLine).toBeGreaterThan(0);
		}
	});

	it("endLine >= startLine for each symbol", () => {
		const symbols = extractSymbols(TS_SOURCE);
		for (const s of symbols) {
			expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
		}
	});

	it("returns empty array for empty source", () => {
		expect(extractSymbols("")).toHaveLength(0);
	});

	it("returns empty array for plain text (no declarations)", () => {
		expect(extractSymbols("// just a comment\n// nothing here")).toHaveLength(0);
	});

	it("add() block starts and ends on correct lines", () => {
		const symbols = extractSymbols(TS_SOURCE);
		const fn = symbols.find((s) => s.name === "add");
		expect(fn?.startLine).toBe(1);
		expect(fn?.endLine).toBe(3); // closing brace on line 3
	});
});

describe("extractBlock", () => {
	const content = `export function foo(): void {\n  console.log("foo");\n}\n\nexport function bar(): void {\n  console.log("bar");\n}\n`;

	it("returns the block content for a known symbol", () => {
		const symbols = extractSymbols(content);
		const block = extractBlock(content, symbols, "foo");
		expect(block).not.toBeNull();
		expect(block?.content).toContain("foo");
		expect(block?.content).not.toContain("bar");
	});

	it("returns null for unknown symbol", () => {
		const symbols = extractSymbols(content);
		expect(extractBlock(content, symbols, "nonexistent")).toBeNull();
	});

	it("block startLine matches symbol startLine", () => {
		const symbols = extractSymbols(content);
		const fooSym = symbols.find((s) => s.name === "foo");
		const block = extractBlock(content, symbols, "foo");
		expect(block?.startLine).toBe(fooSym?.startLine);
	});
});
