/**
 * Lector v2 E2E gate (TSK-67).
 *
 * Proves the 2-call workflow:
 *   1. lector.read(path) → file content + symbol map
 *   2. lector.edit(path, [{ symbol, newText }]) → replaces span
 *
 * No fs.read needed. LectorOrgan provides the full read-then-edit flow.
 * This is the canonical Lector Agent workflow.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalLectorBackend } from "../src/local-backend.js";

const AUTH_TS = `export function login(username: string, password: string): boolean {
  return username.length > 0 && password.length >= 8;
}

export function logout(sessionId: string): void {
  sessions.delete(sessionId);
}

const sessions = new Map<string, string>();
`.trim();

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-e2e-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Lector v2 E2E gate — 2-call workflow", () => {
	it("call 1: lector.read returns content + symbol map", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), AUTH_TS);

		const b = new LocalLectorBackend({ cwd });
		const result = await b.read("auth.ts");

		// Content present
		expect(result.content).toContain("login");
		// Symbol map present
		expect(result.symbols.some((s) => s.name === "login")).toBe(true);
		expect(result.symbols.some((s) => s.name === "logout")).toBe(true);
		// Accurate line numbers via TS compiler API
		const login = result.symbols.find((s) => s.name === "login");
		expect(login?.startLine).toBe(1);
		expect(login?.endLine).toBeGreaterThan(1); // multi-line function
	});

	it("call 2: lector.edit(symbol=) replaces the span without reading oldText", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), AUTH_TS);

		const b = new LocalLectorBackend({ cwd });

		// Call 1: read (populates cache)
		await b.read("auth.ts");

		// Call 2: edit by symbol — no oldText required
		const newLogin =
			"export function login(username: string, password: string): boolean {\n  // enhanced security\n  return username.length > 2 && password.length >= 12;\n}";
		await b.edit("auth.ts", [{ symbol: "login", newText: newLogin }]);

		// Verify
		const updated = await readFile(join(cwd, "auth.ts"), "utf-8");
		expect(updated).toContain("enhanced security");
		expect(updated).toContain("logout"); // unchanged
		expect(updated).not.toContain("password.length >= 8"); // old content gone
	});

	it("symbol zoom: lector.read(path, { symbol }) returns just the function body", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), AUTH_TS);

		const b = new LocalLectorBackend({ cwd });
		const result = await b.read("auth.ts", { symbol: "login" });

		expect(result.content).toContain("login");
		expect(result.content).not.toContain("logout");
		expect(result.totalLines).toBe(AUTH_TS.split("\n").length);
	});

	it("full workflow: read → symbol-zoom → edit proves zero fs.read calls needed", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), AUTH_TS);

		const b = new LocalLectorBackend({ cwd });

		// Step 1: full read to get symbol map
		const full = await b.read("auth.ts");
		expect(full.symbols.length).toBeGreaterThan(0);

		// Step 2: zoom to just the function we want to edit
		const zoom = await b.read("auth.ts", { symbol: "logout" });
		expect(zoom.content).toContain("logout");

		// Step 3: edit by symbol — LLM never needed oldText
		await b.edit("auth.ts", [
			{
				symbol: "logout",
				newText:
					"export function logout(sessionId: string): void {\n  sessions.delete(sessionId);\n  console.log('logged out');\n}",
			},
		]);

		// Verify
		const updated = await readFile(join(cwd, "auth.ts"), "utf-8");
		expect(updated).toContain("logged out");
		expect(updated).toContain("login"); // unchanged
	});
});
