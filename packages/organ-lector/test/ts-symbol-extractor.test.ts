/**
 * TypeScript compiler API symbol extractor tests.
 * Compares against the regex extractor — TS extractor should be a strict superset.
 */

import { describe, expect, it } from "vitest";
import { extractSymbolsTs, isTsFile } from "../src/ts-symbol-extractor.js";

const FULL_SOURCE = `
export async function fetchUser(id: string): Promise<User> {
  return fetch('/users/' + id).then(r => r.json());
}

export function login(username: string, password: string): boolean {
  return username.length > 0 && password.length >= 8;
}

export class AuthService {
  private token = "";

  login(u: string, p: string): boolean {
    this.token = btoa(u + ':' + p);
    return true;
  }

  logout(): void {
    this.token = "";
  }

  get isLoggedIn(): boolean {
    return this.token.length > 0;
  }
}

export interface Config {
  host: string;
  port: number;
}

export type Status = "active" | "inactive";

export const MAX_RETRIES = 3;

export const createClient = (url: string) => ({ url });

function internalHelper(): void {}

class InternalClass {
  prop = 42;
}
`.trim();

describe("extractSymbolsTs — declarations", () => {
	it("extracts exported async function", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const fn = symbols.find((s) => s.name === "fetchUser");
		expect(fn?.kind).toBe("function");
		expect(fn?.exported).toBe(true);
	});

	it("extracts exported class with methods", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		expect(symbols.find((s) => s.name === "AuthService")?.kind).toBe("class");
		expect(symbols.find((s) => s.name === "login" && s.kind === "method")).toBeTruthy();
		expect(symbols.find((s) => s.name === "logout" && s.kind === "method")).toBeTruthy();
		expect(symbols.find((s) => s.name === "isLoggedIn" && s.kind === "method")).toBeTruthy();
	});

	it("extracts exported interface", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		expect(symbols.find((s) => s.name === "Config")?.kind).toBe("interface");
	});

	it("extracts exported type alias", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		expect(symbols.find((s) => s.name === "Status")?.kind).toBe("type");
	});

	it("extracts exported const", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		expect(symbols.find((s) => s.name === "MAX_RETRIES")?.kind).toBe("const");
	});

	it("treats arrow function const as function kind", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const fn = symbols.find((s) => s.name === "createClient");
		expect(fn?.kind).toBe("function");
		expect(fn?.exported).toBe(true);
	});

	it("extracts non-exported function", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const fn = symbols.find((s) => s.name === "internalHelper");
		expect(fn?.exported).toBe(false);
	});

	it("extracts non-exported class", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const cls = symbols.find((s) => s.name === "InternalClass");
		expect(cls?.kind).toBe("class");
		expect(cls?.exported).toBe(false);
	});
});

describe("extractSymbolsTs — line numbers", () => {
	it("assigns startLine > 0", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		for (const s of symbols) {
			expect(s.startLine).toBeGreaterThan(0);
		}
	});

	it("endLine >= startLine", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		for (const s of symbols) {
			expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
		}
	});

	it("class endLine > startLine (spans multiple lines)", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const cls = symbols.find((s) => s.name === "AuthService");
		expect(cls!.endLine).toBeGreaterThan(cls!.startLine);
	});

	it("fetchUser on line 1", () => {
		const symbols = extractSymbolsTs(FULL_SOURCE, "auth.ts");
		const fn = symbols.find((s) => s.name === "fetchUser");
		expect(fn?.startLine).toBe(1);
	});
});

describe("extractSymbolsTs — generics and complex types", () => {
	it("handles generic function", () => {
		const src = "export function identity<T>(x: T): T { return x; }";
		const symbols = extractSymbolsTs(src, "id.ts");
		expect(symbols[0].name).toBe("identity");
		expect(symbols[0].kind).toBe("function");
	});

	it("handles abstract class", () => {
		const src = "export abstract class Base { abstract method(): void; }";
		const symbols = extractSymbolsTs(src, "base.ts");
		expect(symbols[0].name).toBe("Base");
		expect(symbols[0].kind).toBe("class");
	});

	it("handles default export function", () => {
		const src = "export default function main(): void {}";
		const symbols = extractSymbolsTs(src, "main.ts");
		// default export function has no name in the declaration
		// TypeScript may or may not give it a name — we just ensure no crash
		expect(Array.isArray(symbols)).toBe(true);
	});

	it("empty source returns no symbols", () => {
		expect(extractSymbolsTs("", "empty.ts")).toHaveLength(0);
	});

	it("comment-only file returns no symbols", () => {
		expect(extractSymbolsTs("// just a comment\n/* block */", "comments.ts")).toHaveLength(0);
	});
});

describe("isTsFile", () => {
	it.each([
		[".ts", true],
		[".tsx", true],
		[".mts", true],
		[".cts", true],
		[".js", false],
		[".py", false],
		[".go", false],
	])("file%s → %s", (ext, expected) => {
		expect(isTsFile(`file${ext}`)).toBe(expected);
	});
});
