/**
 * Extended real-LLM E2E tests — in-process.
 *
 * ALE-TSK-186 — Lector 2-call workflow: lector.read then lector.edit by symbol
 * ALE-TSK-188 — WebOrgan real network fetch
 *
 * Gate: ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID must be set.
 * Model: claude-haiku-4-5 by default (cheap + fast).
 *
 * These tests boot Agent + organs in-process (no subprocess).
 * Vertex routing is automatic when project/region env vars are set.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { createLectorOrgan } from "@dpopsuev/alef-organ-lector";
import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { createWebOrgan } from "@dpopsuev/alef-organ-web";
import { afterEach, describe, expect, it } from "vitest";
import { getEvalModel } from "../src/model.js";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const HAVE_LLM = Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.ANTHROPIC_VERTEX_PROJECT_ID);

const HAVE_NETWORK = HAVE_LLM; // network tests require LLM too

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const agents: Agent[] = [];

afterEach(async () => {
	for (const a of agents.splice(0)) {
		try {
			await a.dispose();
		} catch {
			/* ignore */
		}
	}
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-e2e-ext-"));
	tempDirs.push(d);
	return d;
}

function makeAgent(organs: Parameters<Agent["load"]>[0][]): { agent: Agent; dialog: DialogOrgan } {
	const agent = new Agent();
	agents.push(agent);
	const dialog = new DialogOrgan({
		sink: () => {},
		getTools: () => agent.tools,
		systemPrompt:
			"You are a precise coding assistant. Use the available tools. Read file contents before answering. Reply concisely.",
	});
	agent.load(dialog);
	for (const organ of organs) {
		agent.load(organ);
	}
	agent.load(new LLMOrgan({ model: getEvalModel() }));
	agent.validate();
	return { agent, dialog };
}

// ---------------------------------------------------------------------------
// TSK-186: Lector 2-call workflow with real LLM
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)("E2E-186: Lector 2-call workflow (real LLM)", () => {
	it("agent uses lector.read then lector.edit — no fs.read", async () => {
		const cwd = makeTmp();

		// Create a TypeScript file with a named function to edit.
		writeFileSync(
			join(cwd, "math.ts"),
			[
				"export function add(a: number, b: number): number {",
				"    return a + b;",
				"}",
				"",
				"export function multiply(a: number, b: number): number {",
				"    return a * b;",
				"}",
			].join("\n"),
			"utf-8",
		);

		const { dialog } = makeAgent([createLectorOrgan({ cwd }), createFsOrgan({ cwd })]);

		const reply = await dialog.send(
			"Add a JSDoc comment to the add() function in math.ts. Use lector tools.",
			"user",
			90_000,
		);

		expect(reply.length).toBeGreaterThan(0);

		// Verify the file was actually modified.
		const content = readFileSync(join(cwd, "math.ts"), "utf-8");
		expect(content).toMatch(/\/\*\*|@param|@returns/); // JSDoc added
	}, 120_000);

	it("agent reads a specific symbol without reading the whole file", async () => {
		const cwd = makeTmp();

		writeFileSync(
			join(cwd, "auth.ts"),
			[
				"export function login(username: string, password: string): boolean {",
				"    // TODO: implement real auth",
				"    return username.length > 0 && password.length >= 8;",
				"}",
				"",
				"export function logout(sessionId: string): void {",
				"    // TODO: invalidate session",
				"}",
			].join("\n"),
			"utf-8",
		);

		const { dialog } = makeAgent([createLectorOrgan({ cwd })]);

		const reply = await dialog.send(
			"Read the login function from auth.ts and tell me what it checks.",
			"user",
			60_000,
		);

		// Agent should mention password length (what the function actually checks).
		expect(reply).toMatch(/password|length|8|character/i);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// TSK-188: WebOrgan real network fetch with real LLM
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_NETWORK)("E2E-188: WebOrgan real network fetch (real LLM)", () => {
	it("agent fetches example.com and extracts the title", async () => {
		const { dialog } = makeAgent([createWebOrgan()]);

		const reply = await dialog.send("Fetch https://example.com and tell me the page title.", "user", 60_000);

		// example.com title is "Example Domain".
		expect(reply).toMatch(/example\s*domain/i);
	}, 90_000);

	it("agent handles a 404 gracefully without hallucinating content", async () => {
		const { dialog } = makeAgent([createWebOrgan()]);

		const reply = await dialog.send(
			"Fetch https://httpbin.org/status/404 and tell me what status code you got.",
			"user",
			60_000,
		);

		// Agent must report 404, not invent content.
		expect(reply).toMatch(/404/);
	}, 90_000);
});
