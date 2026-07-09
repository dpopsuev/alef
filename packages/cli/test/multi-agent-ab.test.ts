/**
 * A/B test harness: single-agent linear vs multi-agent parallel.
 *
 * Task: Build a versioned documentation site for Alef — user guide,
 * developer guide, API reference, architecture docs — with cross-references
 * and links to actual code by git SHA.
 *
 * Mode A: One agent writes all docs sequentially.
 * Mode B: Supervisor decomposes into parallel subagent writers.
 *
 * Measures: elapsed time, file count, total words, cross-reference count.
 * Gated on ALEF_TEST_LLM=1 (requires real LLM).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubagentFactory } from "@dpopsuev/alef-agent/subagent-factory";
import { getModel } from "@dpopsuev/alef-ai/models";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { InProcessStrategy } from "@dpopsuev/alef-engine/in-process";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const HAVE_REAL_LLM = process.env.ALEF_TEST_LLM === "1";
const SEND_TIMEOUT_MS = 180_000;
const GIT_SHA = "dadd8dd42";

const tmps: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-ab-docs-"));
	tmps.push(d);
	return d;
}

afterEach(() => {
	for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function createFsAdapter(cwd: string): Adapter {
	return defineAdapter(
		"fs",
		{
			command: {
				"fs.write": typedAction(
					{
						name: "fs.write",
						description: "Write content to a file. Creates directories as needed.",
						inputSchema: z.object({
							path: z.string().min(1).describe("Relative path within docs/"),
							content: z.string().min(1).describe("File content (markdown)"),
						}),
					},
					// eslint-disable-next-line @typescript-eslint/require-await
					async (ctx) => {
						const fullPath = join(cwd, ctx.payload.path);
						const dir = join(fullPath, "..");
						const { mkdirSync } = await import("node:fs");
						mkdirSync(dir, { recursive: true });
						writeFileSync(fullPath, ctx.payload.content, "utf-8");
						return { written: true, path: ctx.payload.path, bytes: ctx.payload.content.length };
					},
				),
				"fs.read": typedAction(
					{
						name: "fs.read",
						description: "Read a file",
						inputSchema: z.object({ path: z.string().min(1) }),
					},
					// eslint-disable-next-line @typescript-eslint/require-await
					async (ctx) => {
						const fullPath = join(cwd, ctx.payload.path);
						if (!existsSync(fullPath)) return { error: "not found", path: ctx.payload.path };
						return { content: readFileSync(fullPath, "utf-8"), path: ctx.payload.path };
					},
				),
			},
		},
		{ description: "Read and write documentation files.", directives: ["Use fs.write to create doc pages."] },
	);
}

interface ABResult {
	mode: "single" | "multi";
	elapsedMs: number;
	fileCount: number;
	totalWords: number;
	crossRefs: number;
	files: string[];
}

function collectResults(cwd: string, mode: "single" | "multi", elapsedMs: number): ABResult {
	const files: string[] = [];
	const walk = (dir: string, prefix: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
			else if (entry.name.endsWith(".md")) files.push(rel);
		}
	};
	walk(cwd, "");

	let totalWords = 0;
	let crossRefs = 0;
	for (const f of files) {
		const content = readFileSync(join(cwd, f), "utf-8");
		totalWords += content.split(/\s+/).filter(Boolean).length;
		crossRefs += (content.match(/\[.*?\]\(.*?\.md.*?\)/g) ?? []).length;
		crossRefs += (content.match(new RegExp(GIT_SHA, "g")) ?? []).length;
	}

	return { mode, elapsedMs, fileCount: files.length, totalWords, crossRefs, files };
}

const DOCS_TASK = `Build a versioned documentation site for Alef (git SHA: ${GIT_SHA}).

Create these documentation pages as markdown files:

1. docs/index.md — Home page with links to all sections
2. docs/user-guide/getting-started.md — Installation, first run, basic usage
3. docs/user-guide/configuration.md — Config file, model selection, themes
4. docs/developer/architecture.md — Bus, adapters, kernel, engine layers
5. docs/developer/api-reference.md — Key interfaces: Agent, Session, Adapter, Bus
6. docs/developer/contributing.md — How to contribute, test, lint

Requirements:
- Every page must link to at least 2 other pages using relative markdown links
- API reference must link to source files by git SHA (e.g. packages/core/engine/src/agent.ts@${GIT_SHA})
- Index page must link to ALL other pages
- Use proper markdown headings (# ## ###)

Use fs.write for each file.`;

const suite = HAVE_REAL_LLM ? describe : describe.skip;

suite("A/B: single vs multi-agent documentation generation", { tags: ["real-llm"] }, () => {
	function resolveModel() {
		const provider = process.env.ANTHROPIC_VERTEX_PROJECT_ID ? "anthropic-vertex" : "anthropic";
		const modelId = process.env.ALEF_E2E_MODEL ?? "claude-haiku-4-5";
		const model = getModel(provider, modelId);
		if (!model) throw new Error(`Model ${provider}/${modelId} not found`);
		return { model, provider };
	}

	async function runSingleAgent(cwd: string): Promise<ABResult> {
		const { model } = resolveModel();
		const agent = new Agent();
		const fsAdapter = createFsAdapter(cwd);
		const llm = createAgentLoop({ model, timeoutMs: SEND_TIMEOUT_MS });

		agent.load(llm);
		agent.load(fsAdapter);
		agent.load(createToolShellAdapter({ tools: fsAdapter.tools, getTools: () => agent.tools }));

		let _reply = "";
		const controller = new AgentController(agent, {
			onReply: (t) => {
				if (t) _reply = t;
			},
		});
		await agent.ready();

		const start = Date.now();
		await controller.send(DOCS_TASK, "human", SEND_TIMEOUT_MS);
		const elapsed = Date.now() - start;

		controller.dispose();
		await agent.dispose();
		return collectResults(cwd, "single", elapsed);
	}

	async function runMultiAgent(cwd: string): Promise<ABResult> {
		const { model } = resolveModel();
		const agent = new Agent();
		const fsAdapter = createFsAdapter(cwd);
		const llm = createAgentLoop({
			model,
			timeoutMs: SEND_TIMEOUT_MS,
			systemPrompt:
				"You are a supervisor. Decompose doc-writing into parallel agent.run calls — one per page or section. Assemble results at the end.",
		});

		const subFactory = buildSubagentFactory({ model, trackConcurrentOps: true });
		const strategy = new InProcessStrategy([fsAdapter], subFactory);

		const agentAdapter = defineAdapter(
			"agent",
			{
				command: {
					"agent.run": typedAction(
						{
							name: "agent.run",
							description: "Delegate a subtask to a subagent that can write files",
							inputSchema: z.object({
								prompt: z.string().min(1).describe("Task for the subagent"),
								strategy: z.enum(["general"]).default("general"),
							}),
						},
						async (ctx) => {
							const result = await strategy.send({
								text: ctx.payload.prompt,
								sender: "supervisor",
								timeoutMs: SEND_TIMEOUT_MS,
							});
							return { reply: result };
						},
					),
				},
			},
			{
				description: "Delegate subtasks to parallel subagents.",
				directives: ["Run multiple agent.run calls in parallel for independent doc pages."],
			},
		);

		agent.load(llm);
		agent.load(fsAdapter);
		agent.load(agentAdapter);
		agent.load(
			createToolShellAdapter({
				tools: [...fsAdapter.tools, ...agentAdapter.tools],
				getTools: () => agent.tools,
			}),
		);

		let _reply = "";
		const controller = new AgentController(agent, {
			onReply: (t) => {
				if (t) _reply = t;
			},
		});
		await agent.ready();

		const start = Date.now();
		await controller.send(
			DOCS_TASK +
				"\n\nIMPORTANT: Use agent.run to delegate each page to a separate subagent. Run independent pages in parallel.",
			"human",
			SEND_TIMEOUT_MS,
		);
		const elapsed = Date.now() - start;

		controller.dispose();
		await agent.dispose();
		return collectResults(cwd, "multi", elapsed);
	}

	it(
		"[A] single-agent writes versioned docs",
		async () => {
			const cwd = makeTmp();
			const result = await runSingleAgent(cwd);
			console.log(
				`[A] single: ${result.elapsedMs}ms | ${result.fileCount} files | ${result.totalWords} words | ${result.crossRefs} xrefs`,
			);
			console.log(`    files: ${result.files.join(", ")}`);
			expect(result.fileCount, "should create at least 4 doc files").toBeGreaterThanOrEqual(4);
			expect(result.totalWords, "should write substantial content").toBeGreaterThan(200);
		},
		SEND_TIMEOUT_MS + 30_000,
	);

	it(
		"[B] multi-agent writes versioned docs in parallel",
		async () => {
			const cwd = makeTmp();
			const result = await runMultiAgent(cwd);
			console.log(
				`[B] multi: ${result.elapsedMs}ms | ${result.fileCount} files | ${result.totalWords} words | ${result.crossRefs} xrefs`,
			);
			console.log(`    files: ${result.files.join(", ")}`);
			expect(result.fileCount, "should create at least 4 doc files").toBeGreaterThanOrEqual(4);
			expect(result.totalWords, "should write substantial content").toBeGreaterThan(200);
		},
		SEND_TIMEOUT_MS + 30_000,
	);

	it(
		"[A/B] comparison",
		async () => {
			const [cwdA, cwdB] = [makeTmp(), makeTmp()];
			const [a, b] = await Promise.all([runSingleAgent(cwdA), runMultiAgent(cwdB)]);

			console.log("\n=== A/B Documentation Generation Results ===");
			console.log(
				`[A] Single: ${a.elapsedMs}ms | ${a.fileCount} files | ${a.totalWords} words | ${a.crossRefs} xrefs`,
			);
			console.log(
				`[B] Multi:  ${b.elapsedMs}ms | ${b.fileCount} files | ${b.totalWords} words | ${b.crossRefs} xrefs`,
			);
			console.log(
				`Speed:      ${b.elapsedMs < a.elapsedMs ? "Multi wins" : "Single wins"} (${Math.abs(a.elapsedMs - b.elapsedMs)}ms)`,
			);
			console.log(
				`Coverage:   ${b.fileCount > a.fileCount ? "Multi wins" : "Single wins"} (${Math.abs(a.fileCount - b.fileCount)} files)`,
			);
			console.log(
				`Depth:      ${b.totalWords > a.totalWords ? "Multi wins" : "Single wins"} (${Math.abs(a.totalWords - b.totalWords)} words)`,
			);
			console.log(
				`Links:      ${b.crossRefs > a.crossRefs ? "Multi wins" : "Single wins"} (${Math.abs(a.crossRefs - b.crossRefs)} xrefs)`,
			);

			expect(a.fileCount + b.fileCount).toBeGreaterThan(0);
		},
		(SEND_TIMEOUT_MS + 30_000) * 2,
	);
});

describe("A/B harness — structural smoke (faux LLM)", { tags: ["unit"] }, () => {
	it("collectResults counts files, words, and cross-references", () => {
		const cwd = makeTmp();
		const { mkdirSync } = require("node:fs") as typeof import("node:fs"); // eslint-disable-line @typescript-eslint/no-require-imports
		mkdirSync(join(cwd, "docs"), { recursive: true });
		writeFileSync(
			join(cwd, "docs/index.md"),
			`# Alef Docs\n\n[Guide](guide.md) | [API](api.md)\n\nSHA: ${GIT_SHA}\n`,
		);
		writeFileSync(join(cwd, "docs/guide.md"), "# Guide\n\nGetting started with Alef.\n\n[Back](index.md)\n");
		writeFileSync(join(cwd, "docs/api.md"), `# API\n\nSee [source](agent.ts@${GIT_SHA})\n\n[Back](index.md)\n`);

		const result = collectResults(cwd, "single", 1000);
		expect(result.fileCount).toBe(3);
		expect(result.totalWords).toBeGreaterThan(10);
		expect(result.crossRefs).toBeGreaterThanOrEqual(4);
	});
});
