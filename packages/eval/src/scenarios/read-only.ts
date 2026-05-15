/**
 * ReadOnly scenarios — agent reads code, produces analysis. No writes expected.
 * Scoring: READ_ONLY_RULES (reads rewarded, writes penalised).
 */

import type { ScenarioContext } from "../harness.js";

// ---------------------------------------------------------------------------
// Seed files
// ---------------------------------------------------------------------------

const HTTP_SERVER_SEED = `
import http from "node:http";

export function createServer(port: number) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && req.url === "/echo") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echoed: body }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}
`.trim();

const DEAD_CODE_SEED = `
export function add(a: number, b: number): number {
  return a + b;
}

// This function is never called anywhere
function _internalHelper(x: number): number {
  return x * 2;
}

export function multiply(a: number, b: number): number {
  // Old implementation — replaced but left in
  function legacyMultiply(a: number, b: number): number {
    let result = 0;
    for (let i = 0; i < b; i++) result += a;
    return result;
  }
  void legacyMultiply;
  return a * b;
}

export class Calculator {
  add(a: number, b: number) { return add(a, b); }
  multiply(a: number, b: number) { return multiply(a, b); }
  // Dead method — never used
  private reset() { return 0; }
}
`.trim();

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * PlanRefactoring — given a module, produce a refactoring plan.
 * Pass condition: reply mentions the module or specific functions.
 */
export async function planRefactoring(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile("src/server.ts", HTTP_SERVER_SEED);
	const reply = await ctx.send(
		"Read src/server.ts and give me a concise refactoring plan to improve it. " +
			"List the top 3 concrete improvements.",
	);
	if (!reply || reply.trim().length < 50) {
		throw new Error(`Reply too short (${reply.length} chars) — agent may not have read the file`);
	}
	// Agent should mention the file or its contents
	const lower = reply.toLowerCase();
	const mentionsRelevantContent =
		lower.includes("server") ||
		lower.includes("route") ||
		lower.includes("handler") ||
		lower.includes("request") ||
		lower.includes("response") ||
		lower.includes("http") ||
		lower.includes("endpoint");
	if (!mentionsRelevantContent) {
		throw new Error("Reply does not mention server-related content — agent may not have read the file");
	}
}

/**
 * AuditModule — given a module with dead code, identify it.
 * Pass condition: reply identifies the dead/unused code.
 */
export async function auditModule(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile("src/math.ts", DEAD_CODE_SEED);
	const reply = await ctx.send(
		"Read src/math.ts and identify any dead code, unused functions, or unreachable code. " +
			"Be specific about what is dead and why.",
	);
	const lower = reply.toLowerCase();
	const identifiesDead =
		lower.includes("dead") ||
		lower.includes("unused") ||
		lower.includes("never called") ||
		lower.includes("_internalhelper") ||
		lower.includes("legacymultiply") ||
		lower.includes("reset");
	if (!identifiesDead) {
		throw new Error("Agent did not identify dead code in the module");
	}
}

/**
 * BlastRadius — given a function, identify what would break if it changes.
 * Pass condition: reply references the function and potential callers/dependents.
 */
export async function blastRadius(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile("src/math.ts", DEAD_CODE_SEED);
	await ctx.writeFile(
		"src/app.ts",
		`
import { Calculator } from "./math.js";
const calc = new Calculator();
export function compute(a: number, b: number) {
  return calc.add(a, b) + calc.multiply(a, b);
}
`.trim(),
	);

	const reply = await ctx.send(
		"Read src/math.ts and src/app.ts. If I change the signature of the 'add' function in math.ts, " +
			"what would break? List all affected locations.",
	);
	const lower = reply.toLowerCase();
	const mentionsImpact =
		lower.includes("app") ||
		lower.includes("calculator") ||
		lower.includes("compute") ||
		lower.includes("calc") ||
		lower.includes("caller") ||
		lower.includes("break");
	if (!mentionsImpact) {
		throw new Error("Agent did not identify the blast radius of the change");
	}
}

/**
 * ContextWarming — read multiple files, then answer a cross-file question.
 * Pass condition: reply references content from multiple files correctly.
 */
export async function contextWarming(ctx: ScenarioContext): Promise<void> {
	await ctx.writeFile(
		"src/types.ts",
		`
export interface User { id: string; name: string; role: "admin" | "user"; }
export interface Session { userId: string; token: string; expiresAt: number; }
`.trim(),
	);
	await ctx.writeFile(
		"src/auth.ts",
		`
import type { User, Session } from "./types.js";
export function createSession(user: User): Session {
  return { userId: user.id, token: crypto.randomUUID(), expiresAt: Date.now() + 3600_000 };
}
export function isExpired(session: Session): boolean {
  return Date.now() > session.expiresAt;
}
`.trim(),
	);
	await ctx.writeFile(
		"src/middleware.ts",
		`
import type { Session } from "./types.js";
import { isExpired } from "./auth.js";
export function authMiddleware(session: Session | null): boolean {
  if (!session) return false;
  return !isExpired(session);
}
`.trim(),
	);

	const reply = await ctx.send(
		"Read all TypeScript files in src/ and tell me: " +
			"what type does authMiddleware receive, and where is that type defined?",
	);
	const lower = reply.toLowerCase();
	const correct =
		(lower.includes("session") && lower.includes("types")) ||
		(lower.includes("session") && lower.includes("types.ts")) ||
		lower.includes("session | null") ||
		lower.includes("session or null");
	if (!correct) {
		throw new Error("Agent did not correctly trace the type across files");
	}
}
