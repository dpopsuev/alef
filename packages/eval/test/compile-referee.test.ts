/**
 * CompileReferee tests — no LLM, uses real tsc binary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileCheck } from "../src/referees/compile.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-compile-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("compileCheck referee", () => {
	it("passes on valid TypeScript", async () => {
		const ws = tmp();
		writeFileSync(join(ws, "index.ts"), "export const x: number = 42;\n");
		const result = await compileCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(true);
		expect(result.score).toBe(1.0);
	});

	it("fails on type error", async () => {
		const ws = tmp();
		writeFileSync(join(ws, "index.ts"), "const x: number = 'wrong';\n");
		const result = await compileCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0);
		expect(result.errors.some((e) => e.includes("TS"))).toBe(true);
	});

	it("writes tsconfig.json if missing", async () => {
		const ws = tmp();
		writeFileSync(join(ws, "ok.ts"), "export {};\n");
		await compileCheck().check({ workspace: ws, spans: [] });
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(ws, "tsconfig.json"))).toBe(true);
	});

	it("uses existing tsconfig.json if present", async () => {
		const ws = tmp();
		// Minimal tsconfig that relaxes strict mode
		writeFileSync(
			join(ws, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { noEmit: true, strict: false, skipLibCheck: true } }),
		);
		writeFileSync(join(ws, "ok.ts"), "const x = 1 as any;\n");
		const result = await compileCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(true);
	});

	it("fixture: FixFailingTest correct implementation compiles", async () => {
		const ws = tmp();
		writeFileSync(
			join(ws, "sum.ts"),
			"export function sum(numbers: number[]): number {\n  return numbers.reduce((a, b) => a + b, 0);\n}\n",
		);
		const result = await compileCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(true);
	});
});
