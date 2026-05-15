/**
 * Write scenarios — agent modifies or creates files.
 * Scoring: WRITE_RULES (writes rewarded).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioContext } from "../harness.js";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * CreateHTTPServer — agent creates a Node.js HTTP server from a spec.
 * Pass: file exists + contains required content.
 */
export async function createHTTPServer(ctx: ScenarioContext): Promise<void> {
	await ctx.send(
		"Create a file src/server.ts with a Node.js HTTP server that:\n" +
			"1. Has a GET /health endpoint returning { status: 'ok' }\n" +
			"2. Has a POST /echo endpoint that echoes the request body\n" +
			"3. Exports a createServer(port: number) function\n" +
			"Use only the built-in node:http module. No frameworks.",
	);

	const content = await ctx.readFile("src/server.ts");
	if (!content.includes("createServer")) throw new Error("createServer function not found");
	if (!content.includes("/health")) throw new Error("/health endpoint not found");
	if (!content.includes("/echo")) throw new Error("/echo endpoint not found");
}

/**
 * AddTypeExport — agent adds a missing type export to an existing module.
 * Pass: the type is exported from the correct file.
 */
export async function addTypeExport(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile(
		"src/types.ts",
		`
export interface User { id: string; name: string; }
// TODO: export the Session type too
interface Session { userId: string; token: string; expiresAt: number; }
`.trim(),
	);

	await ctx.send(
		"Read src/types.ts. The Session interface is defined but not exported. " +
			"Fix it so Session is exported. Only change that file.",
	);

	const content = await ctx.readFile("src/types.ts");
	if (!content.includes("export interface Session") && !content.includes("export type Session")) {
		throw new Error("Session is not exported from src/types.ts");
	}
}

/**
 * FixFailingTest — agent reads a failing test, finds the bug, fixes the implementation.
 * Pass: implementation file modified + the fix is correct.
 */
export async function fixFailingTest(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile(
		"src/math.ts",
		`
export function add(a: number, b: number): number {
  return a - b; // BUG: should be a + b
}
`.trim(),
	);

	await ctx.writeFile(
		"src/math.test.ts",
		`
import { add } from "./math.js";
import { describe, it, expect } from "vitest";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});
`.trim(),
	);

	await ctx.send(
		"Read src/math.ts and src/math.test.ts. The test is failing. " +
			"Find the bug in the implementation and fix it. Only edit src/math.ts.",
	);

	const content = await ctx.readFile("src/math.ts");
	if (!content.includes("a + b")) {
		throw new Error("Bug not fixed: add function still doesn't return a + b");
	}
}

/**
 * RefactorAsync — agent refactors callback-based code to async/await.
 * Pass: result file uses async/await, no callbacks.
 */
export async function refactorAsync(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile(
		"src/config.ts",
		`
import * as fs from "node:fs";

export function readConfig(path: string, callback: (err: Error | null, data: string | null) => void): void {
  fs.readFile(path, "utf-8", (err, data) => {
    if (err) { callback(err, null); return; }
    callback(null, data);
  });
}
`.trim(),
	);

	await ctx.send(
		"Read src/config.ts and refactor readConfig to use async/await instead of callbacks. " +
			"The refactored function should return Promise<string>. " +
			"Update the file in place.",
	);

	const content = await ctx.readFile("src/config.ts");
	if (!content.includes("async")) throw new Error("Refactored function is not async");
	if (!content.includes("await")) throw new Error("Refactored function does not use await");
	if (!content.includes("Promise<string>")) {
		throw new Error("Refactored function does not return Promise<string>");
	}
	if (content.includes("callback")) {
		// Callback arg in signature is gone — some implementations may reference it in comments
		const withoutComments = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
		if (withoutComments.includes("callback")) {
			throw new Error("Refactored function still uses callbacks in implementation");
		}
	}
}

/**
 * WriteMiddleware — agent adds logging middleware to an existing Express-style stack.
 * Pass: middleware file created with correct shape.
 */
export async function writeMiddleware(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile(
		"src/app.ts",
		`
type Handler = (req: { method: string; url: string }, res: { end: (body: string) => void }) => void;
type Middleware = (req: { method: string; url: string }, res: { end: (body: string) => void }, next: () => void) => void;

export function compose(...middleware: Middleware[]): Handler {
  return (req, res) => {
    let i = 0;
    const next = () => { if (i < middleware.length) middleware[i++](req, res, next); };
    next();
  };
}
`.trim(),
	);

	await ctx.send(
		"Read src/app.ts. Create a new file src/logging-middleware.ts that exports a " +
			"'loggingMiddleware' function compatible with the Middleware type in src/app.ts. " +
			"It should log 'method url' to console before calling next().",
	);

	const content = await readFile(join(ctx.workspace, "src/logging-middleware.ts"), "utf-8");
	if (!content.includes("loggingMiddleware")) throw new Error("loggingMiddleware not found");
	if (!content.includes("next")) throw new Error("middleware does not call next()");
	if (!content.includes("console")) throw new Error("middleware does not log");
}
