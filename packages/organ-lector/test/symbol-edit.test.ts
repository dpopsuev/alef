/**
 * Symbol-span edit tests — Lector v2 Phase 2.
 * Tests the symbol=... edit path in both StubBackend and LocalBackend.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalLectorBackend } from "../src/local-backend.js";
import { StubLectorBackend } from "../src/stub-backend.js";

const SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

// ---------------------------------------------------------------------------
// StubLectorBackend — symbol edit
// ---------------------------------------------------------------------------

describe("StubLectorBackend — symbol edit", () => {
	it("replaces a named symbol's span", async () => {
		const b = new StubLectorBackend({ "math.ts": SRC });
		await b.edit("math.ts", [
			{
				symbol: "subtract",
				newText: "export function subtract(a: number, b: number): number {\n  return a - b - 1; // modified\n}",
			},
		]);
		const result = await b.read("math.ts");
		expect(result.content).toContain("a - b - 1");
		expect(result.content).toContain("add"); // unchanged
	});

	it("preserves other functions when replacing one", async () => {
		const b = new StubLectorBackend({ "math.ts": SRC });
		await b.edit("math.ts", [
			{ symbol: "add", newText: "export function add(a: number, b: number): number { return a + b + 1; }" },
		]);
		const result = await b.read("math.ts");
		expect(result.content).toContain("subtract"); // unchanged
		expect(result.content).toContain("a + b + 1");
	});

	it("throws when symbol not found", async () => {
		const b = new StubLectorBackend({ "math.ts": SRC });
		await expect(b.edit("math.ts", [{ symbol: "nonexistent", newText: "x" }])).rejects.toThrow(/not found/);
	});

	it("still supports oldText edits alongside symbol edits", async () => {
		const b = new StubLectorBackend({ "math.ts": SRC });
		await b.edit("math.ts", [{ oldText: "return a + b;", newText: "return a + b + 1;" }]);
		const result = await b.read("math.ts");
		expect(result.content).toContain("a + b + 1");
	});
});

// ---------------------------------------------------------------------------
// LocalLectorBackend — symbol edit (uses TS compiler API for symbol map)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-sym-edit-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("LocalLectorBackend — symbol edit with Optimistic Lock", () => {
	it("replaces symbol span after a lector.read populates the cache", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "math.ts"), SRC, "utf-8");

		const b = new LocalLectorBackend({ cwd });
		// Read first to populate cache
		await b.read("math.ts");
		// Symbol edit
		await b.edit("math.ts", [
			{
				symbol: "subtract",
				newText: "export function subtract(a: number, b: number): number { return a - b - 1; }",
			},
		]);
		const result = await b.read("math.ts");
		expect(result.content).toContain("a - b - 1");
		expect(result.content).toContain("add");
	});

	it("throws when cache is empty (no prior read)", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "math.ts"), SRC, "utf-8");
		const b = new LocalLectorBackend({ cwd });
		// No read — cache is empty
		await expect(b.edit("math.ts", [{ symbol: "add", newText: "x" }])).rejects.toThrow(/no cached symbol map/);
	});

	it("throws when symbol not in cache", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "math.ts"), SRC, "utf-8");
		const b = new LocalLectorBackend({ cwd });
		await b.read("math.ts");
		await expect(b.edit("math.ts", [{ symbol: "multiply", newText: "x" }])).rejects.toThrow(/not found/);
	});
});
