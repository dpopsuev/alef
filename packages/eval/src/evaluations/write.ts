/**
 * Write evaluations — ToolLevel: ReadWrite
 * Agent reads then writes. Checker verifies the resulting files.
 *
 * expects: agent must have read the seed file AND written the output file.
 * checker: verifies the produced file is correct — proves the write happened.
 */

import { all, fileContains, fileExists } from "../checker.js";
import { compileCheck } from "../checkers/compile.js";
import { testCheck } from "../checkers/test.js";
import type { Evaluation } from "../evaluation.js";

const READ_TOOLS = ["fs.read", "code.read"] as const;
const WRITE_TOOLS = ["fs.write", "fs.edit", "code.write", "code.edit"] as const;

const TYPES_SEED = `
export interface User { id: string; name: string; }
// TODO: export the Session type too
interface Session { userId: string; token: string; expiresAt: number; }
`.trim();

const CALLBACK_SEED = `
export function fetchData(url: string, callback: (err: Error | null, data: string) => void): void {
  setTimeout(() => {
    if (url.startsWith("http")) {
      callback(null, "data from " + url);
    } else {
      callback(new Error("invalid url"), "");
    }
  }, 100);
}
`.trim();

const BUGGY_SEED = `
export function sum(numbers: number[]): number {
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {  // bug: <= should be <
    total += numbers[i];
  }
  return total;
}
`.trim();

const BUGGY_TEST = `
import { sum } from "./sum";
import { expect, it } from "vitest";
it("sums correctly", () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0);
});
`.trim();

const MIDDLEWARE_SPEC = `
// Middleware must:
// - accept (req, res, next) signature
// - log method + url to console
// - call next()
`.trim();

export const createHTTPServer: Evaluation = {
	id: "CreateHTTPServer",
	toolLevel: "ReadWrite",
	template: "Write",
	prompt:
		"Create src/server.ts with a Node.js HTTP server (node:http only, no frameworks) that:\n" +
		"1. GET /health → { status: 'ok' } with 200\n" +
		"2. POST /echo → echoes the request body with 200\n" +
		"3. Exports createServer(port: number)",
	expects: [{ tool: WRITE_TOOLS, target: { path: "src/server.ts" } }],
	checker: all(fileContains("src/server.ts", "createServer", "/health", "/echo"), compileCheck()),
	fixture: {
		files: {
			"src/server.ts":
				'import http from "node:http";\nexport function createServer(port: number) {\n  const s = http.createServer((req, res) => {\n    if (req.method === "GET" && req.url === "/health") { res.writeHead(200); res.end(\'{"status":"ok"}\'); return; }\n    if (req.method === "POST" && req.url === "/echo") { let b=""; req.on("data",c=>b+=c); req.on("end",()=>{res.writeHead(200);res.end(b);}); return; }\n    res.writeHead(404); res.end();\n  });\n  s.listen(port); return s;\n}',
		},
	},
};

export const addTypeExport: Evaluation = {
	id: "AddTypeExport",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "src/types.ts", content: TYPES_SEED }],
	prompt:
		"Read src/types.ts. The Session interface is defined but not exported. " +
		"Fix it so Session is exported. Only change that file.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "src/types.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/types.ts" } },
	],
	checker: all(fileContains("src/types.ts", "export interface Session", "export"), compileCheck()),
	fixture: {
		files: {
			"src/types.ts":
				"export interface User { id: string; name: string; }\nexport interface Session { userId: string; token: string; expiresAt: number; }",
		},
	},
};

export const fixFailingTest: Evaluation = {
	id: "FixFailingTest",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [
		{ path: "src/sum.ts", content: BUGGY_SEED },
		{ path: "src/sum.test.ts", content: BUGGY_TEST },
	],
	prompt:
		"Read src/sum.ts and src/sum.test.ts. The test fails. Find the bug in sum.ts and fix it. " +
		"Do not modify the test file.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "src/sum.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/sum.ts" } },
	],
	checker: all(fileContains("src/sum.ts", "< numbers.length"), compileCheck(), testCheck()),
	fixture: {
		files: {
			"src/sum.ts":
				"export function sum(numbers: number[]): number {\n  let total = 0;\n  for (let i = 0; i < numbers.length; i++) {\n    total += numbers[i];\n  }\n  return total;\n}",
			"src/sum.test.ts":
				"import { sum } from './sum.js';\nimport { expect, it } from 'vitest';\nit('sums correctly', () => { expect(sum([1,2,3])).toBe(6); expect(sum([])).toBe(0); });\n",
		},
	},
};

export const refactorAsync: Evaluation = {
	id: "RefactorAsync",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "src/fetch.ts", content: CALLBACK_SEED }],
	prompt:
		"Read src/fetch.ts. Refactor fetchData to use async/await instead of callbacks. " +
		"Use the await keyword explicitly inside the function body. " +
		"Keep the same behaviour — reject on invalid URLs, resolve with data string on valid ones.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "src/fetch.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/fetch.ts" } },
	],
	checker: all(fileContains("src/fetch.ts", "async", "await")),
	fixture: {
		files: {
			"src/fetch.ts":
				"export async function fetchData(url: string): Promise<string> {\n  if (!url.startsWith('http')) throw new Error('invalid url');\n  await new Promise(r => setTimeout(r, 100));\n  return 'data from ' + url;\n}",
		},
	},
};

export const writeMiddleware: Evaluation = {
	id: "WriteMiddleware",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "src/middleware-spec.ts", content: MIDDLEWARE_SPEC }],
	prompt:
		"Read src/middleware-spec.ts for the requirements. " +
		"Create src/logging-middleware.ts that exports a default Express-compatible " +
		"middleware function matching the spec.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "src/middleware-spec.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/logging-middleware.ts" } },
	],
	checker: all(
		fileExists("src/logging-middleware.ts"),
		fileContains("src/logging-middleware.ts", "next", "req", "res"),
	),
};
