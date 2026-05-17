/**
 * ReadOnly evaluations — ToolLevel: ReadOnly
 * Agent reads code and produces analysis.
 * mustNotUse: fs.write, fs.edit — no mutations.
 */

import type { Evaluation } from "../evaluation.js";
import { replyContains } from "../referee.js";

const HTTP_SERVER = `
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

const DEAD_CODE = `
export function add(a: number, b: number): number {
  return a + b;
}

// Never called anywhere
function _internalHelper(x: number): number {
  return x * 2;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`.trim();

const AUTH = `
export function login(username: string, password: string): boolean {
  return username.length > 0 && password.length >= 8;
}
export function logout(sessionId: string): void { sessions.delete(sessionId); }
const sessions = new Map<string, string>();
export function createSession(username: string): string {
  const id = Math.random().toString(36).slice(2);
  sessions.set(id, username);
  return id;
}
`.trim();

const TYPES = `
export interface User { id: string; name: string; email: string; }
export interface Order { id: string; userId: string; items: OrderItem[]; total: number; }
export interface OrderItem { productId: string; quantity: number; price: number; }
`.trim();

export const planRefactoring: Evaluation = {
	id: "PlanRefactoring",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	seed: [{ path: "src/server.ts", content: HTTP_SERVER }],
	prompt:
		"Read src/server.ts. Identify 2-3 concrete refactoring opportunities. " +
		"For each: state what to change and why. Be specific about line numbers and function names.",
	mustUse: ["fs.read"],
	mustNotUse: ["fs.write", "fs.edit"],
	referee: replyContains("createServer", "refactor"),
};

export const auditModule: Evaluation = {
	id: "AuditModule",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	seed: [{ path: "src/utils.ts", content: DEAD_CODE }],
	prompt:
		"Read src/utils.ts. Identify any dead code — functions defined but never called " +
		"within this file. List the function names.",
	mustUse: ["fs.read"],
	mustNotUse: ["fs.write", "fs.edit"],
	referee: replyContains("_internalHelper"),
};

export const blastRadius: Evaluation = {
	id: "BlastRadius",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	seed: [
		{ path: "src/auth.ts", content: AUTH },
		{
			path: "src/api.ts",
			content:
				'import { login, createSession } from "./auth";\nexport async function handleLogin(u: string, p: string) {\n  if (!login(u, p)) throw new Error("bad");\n  return createSession(u);\n}',
		},
	],
	prompt:
		"Read src/auth.ts and src/api.ts. If I rename 'login' to 'authenticate' in auth.ts, " +
		"which files and lines would need to change?",
	mustUse: ["fs.read"],
	mustNotUse: ["fs.write", "fs.edit"],
	referee: replyContains("api.ts"),
};

export const contextWarming: Evaluation = {
	id: "ContextWarming",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	seed: [
		{ path: "src/types.ts", content: TYPES },
		{
			path: "src/order.ts",
			content:
				'import type { Order, OrderItem } from "./types";\nexport function totalItems(order: Order): number {\n  return order.items.reduce((sum: number, item: OrderItem) => sum + item.quantity, 0);\n}',
		},
	],
	prompt:
		"Read src/types.ts and src/order.ts. What does totalItems() return for an order " +
		"with two items of quantity 3 and 5?",
	mustUse: ["fs.read"],
	mustNotUse: ["fs.write", "fs.edit"],
	referee: replyContains("8"),
};
