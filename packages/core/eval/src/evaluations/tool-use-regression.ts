/**
 * Tool-use regression evaluations.
 *
 * Catches the progressive disclosure bug: LLM outputs JSON text describing
 * tool calls instead of making actual tool_use API calls. This happens when
 * the ToolShell sends stripped schemas ({}) and the model can't construct
 * proper tool_use blocks.
 *
 * These evals use simple, unambiguous prompts that MUST result in real tool
 * calls. If the model outputs text instead, toolCallsAreReal detects it.
 */

import { all, fileContains, fileExists, replyContains } from "../checker.js";
import type { Evaluation } from "../evaluation.js";
import { toolCallsAreReal } from "../checkers/tool-use-detector.js";

const SEED_FILE = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const SECRET = "XYZZY_42_PLUGH";

export const singleToolCall: Evaluation = {
	id: "ToolUse_SingleCall",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	kind: "regression",
	seed: [{ path: "src/greet.ts", content: SEED_FILE }],
	prompt: "Read the file src/greet.ts and tell me the function name defined in it.",
	expects: [{ tool: ["fs.read", "code.read"], target: { path: "src/greet.ts" } }],
	checker: all(replyContains("greet"), toolCallsAreReal()),
};

export const multiToolCall: Evaluation = {
	id: "ToolUse_MultiCall",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	kind: "regression",
	seed: [
		{ path: "src/a.ts", content: `export const A_TOKEN = "${SECRET}";` },
		{ path: "src/b.ts", content: 'export const B_VALUE = "nothing special";' },
	],
	prompt: "Read both src/a.ts and src/b.ts. Tell me the value of A_TOKEN.",
	expects: [
		{ tool: ["fs.read", "code.read"], target: { path: "src/a.ts" } },
		{ tool: ["fs.read", "code.read"], target: { path: "src/b.ts" } },
	],
	checker: all(replyContains(SECRET), toolCallsAreReal()),
};

export const grepThenRead: Evaluation = {
	id: "ToolUse_GrepThenRead",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	kind: "regression",
	seed: [
		{ path: "src/config.ts", content: `export const DB_HOST = "localhost";\nexport const DB_PORT = 5432;` },
		{ path: "src/main.ts", content: 'import { DB_HOST } from "./config";\nconsole.log(DB_HOST);' },
	],
	prompt: "Search the codebase for DB_HOST. Which files reference it? Read them and tell me the value.",
	expects: [{ tool: ["fs.grep", "code.search"], target: { pattern: /DB_HOST/i } }],
	checker: all(replyContains("localhost"), toolCallsAreReal()),
};

export const writeFile: Evaluation = {
	id: "ToolUse_WriteFile",
	toolLevel: "ReadWrite",
	template: "Write",
	kind: "regression",
	seed: [],
	prompt: "Create a file called hello.txt containing exactly 'hello world'. Nothing else.",
	expects: [{ tool: ["fs.write", "fs.edit", "code.write"] }],
	checker: all(
		fileExists("hello.txt"),
		fileContains("hello.txt", "hello world"),
		toolCallsAreReal(),
	),
};

export const openEndedExploration: Evaluation = {
	id: "ToolUse_OpenEndedExploration",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	kind: "regression",
	seed: [
		{ path: "src/server.ts", content: 'import http from "http";\nconst s = http.createServer();\ns.listen(3000);' },
		{ path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" },
		{ path: "src/types.ts", content: "export interface User { id: string; name: string; }" },
		{ path: "src/config.ts", content: 'export const DB_HOST = "localhost";\nexport const DB_PORT = 5432;' },
		{ path: "package.json", content: '{"name": "test-project", "version": "1.0.0"}' },
	],
	prompt:
		"Explore the code base with subagents. " +
		"Score it by: Functionality, Architecture, and Performance. " +
		"Search online for TypeScript best practices. " +
		"Spawn 3 subagents to analyze different areas.",
	expects: [
		{ tool: ["fs.find", "fs.read", "fs.grep", "code.read", "code.search", "agent.run"] },
	],
	checker: toolCallsAreReal(),
};

export const complexMultiTool: Evaluation = {
	id: "ToolUse_ComplexMultiTool",
	toolLevel: "ReadOnly",
	template: "ReadOnly",
	kind: "regression",
	seed: [
		{ path: "src/server.ts", content: 'import http from "http";\nconst s = http.createServer();\ns.listen(3000);' },
		{ path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" },
		{ path: "src/types.ts", content: "export interface User { id: string; name: string; }" },
		{ path: "package.json", content: '{"name": "test-project", "version": "1.0.0"}' },
	],
	prompt:
		"Find all TypeScript files, read each one, and give me a summary of what this project does. " +
		"Also search for any imports between files.",
	expects: [
		{ tool: ["fs.find"] },
		{ tool: ["fs.read", "code.read"] },
	],
	checker: toolCallsAreReal(),
};
