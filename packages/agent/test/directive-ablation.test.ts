/**
 * Directive ablation — A/B test for no-emojis and no-files directives.
 *
 * Gate: ALEF_TEST_LLM=1 (real LLM required). Tag: real-llm.
 *
 * Variant A (baseline): bare system prompt without directives.
 * Variant B (treatment): full directive system with no-emojis/no-files blocks.
 *
 * Prompt designed to provoke both violations:
 *   "Analyze this project and write a summary document."
 */

import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultDirectives } from "../src/prompt.js";

const HAVE_LLM = process.env.ALEF_TEST_LLM === "1";

const EMOJI_RE =
	/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2702}-\u{27B0}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{2714}\u{2716}\u{2728}\u{274C}\u{2753}-\u{2757}\u{2764}\u{2795}-\u{2797}\u{27A1}]/u;

const PROVOCATION =
	"Analyze this project's file structure and write a summary document with your findings and recommendations.";

function findMdFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { recursive: true })
			.map(String)
			.filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
}

async function createSessionWithPrompt(adapters: Adapter[], systemPrompt: string) {
	const { getEnvApiKey } = await import("../../core/ai/src/env-api-keys.js");
	const { getModel } = await import("../../core/ai/src/models.js");
	const { createAgentLoop } = await import("../../core/reasoner/src/index.js");
	const { Agent, AgentController, createToolShellAdapter } = await import("../../core/runtime/src/index.js");

	const provider = process.env.ANTHROPIC_VERTEX_PROJECT_ID ? "anthropic-vertex" : "anthropic";
	const apiKey = getEnvApiKey(provider) ?? "";
	const model =
		getModel(provider as "anthropic", "claude-haiku-4-5" as never) ??
		getModel("anthropic", "claude-haiku-4-5" as never);

	const agent = new Agent();
	let reply = "";
	const events: NotificationMessage[] = [];

	const llm = createAgentLoop({ model, getApiKey: () => apiKey, timeoutMs: 30_000, systemPrompt });

	for (const adapter of adapters) agent.load(adapter);
	const toolShell = createToolShellAdapter({ tools: adapters.flatMap((o) => o.tools), getTools: () => agent.tools });
	const pipeline = createContextAssemblyPipeline();
	agent.load(toolShell);
	agent.load(pipeline);
	agent.load(llm);
	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			events.push(event as NotificationMessage);
		},
	});

	const controller = new AgentController(agent, {
		onReply: (t) => {
			if (t) reply = t;
		},
	});

	return {
		async send(text: string) {
			reply = "";
			events.length = 0;
			await agent.ready();
			await controller.send(text, "human", 30_000);
			return { reply, events: [...events] };
		},
		dispose() {
			controller.dispose();
			agent.dispose();
		},
	};
}

describe.skipIf(!HAVE_LLM)("directive ablation — no-emojis & no-files", { timeout: 60_000 }, () => {
	let workspace: string;

	beforeAll(async () => {
		workspace = await mkdtemp(join(tmpdir(), "alef-ablation-"));
		await writeFile(join(workspace, "index.ts"), 'export const hello = "world";\n');
		await writeFile(join(workspace, "utils.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		await writeFile(join(workspace, "config.ts"), "export const PORT = 3000;\nexport const HOST = 'localhost';\n");
	});

	afterAll(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	it("treatment: reply contains no emojis with directives active", async () => {
		const { createFsAdapter } = await import("../../tools/fs/src/index.js");
		const tools = [createFsAdapter({ cwd: workspace })];
		const directives = createDefaultDirectives({ tools: tools.flatMap((o) => o.tools), cwd: workspace });
		const systemPrompt = directives.build(20_000);

		const session = await createSessionWithPrompt(tools, systemPrompt);
		try {
			const { reply } = await session.send(PROVOCATION);
			const emojis = reply.match(new RegExp(EMOJI_RE.source, "gu")) ?? [];
			expect(emojis, `Reply contained emojis: ${emojis.join(" ")}\n\nReply:\n${reply.slice(0, 500)}`).toHaveLength(
				0,
			);
		} finally {
			session.dispose();
		}
	});

	it("treatment: no .md files created with directives active", async () => {
		const { createFsAdapter } = await import("../../tools/fs/src/index.js");
		const mdBefore = findMdFiles(workspace);
		const tools = [createFsAdapter({ cwd: workspace })];
		const directives = createDefaultDirectives({ tools: tools.flatMap((o) => o.tools), cwd: workspace });
		const systemPrompt = directives.build(20_000);

		const session = await createSessionWithPrompt(tools, systemPrompt);
		try {
			await session.send(PROVOCATION);
			const mdAfter = findMdFiles(workspace);
			const newMd = mdAfter.filter((f) => !mdBefore.includes(f));
			expect(newMd, `Agent created .md files: ${newMd.join(", ")}`).toHaveLength(0);
		} finally {
			session.dispose();
		}
	});

	it("baseline: bare prompt without directives (observation only)", async () => {
		const { createFsAdapter } = await import("../../tools/fs/src/index.js");
		const bare = "You are a coding assistant. Help the user with their request.";
		const tools = [createFsAdapter({ cwd: workspace })];

		const session = await createSessionWithPrompt(tools, bare);
		try {
			const { reply } = await session.send(PROVOCATION);
			const emojis = reply.match(new RegExp(EMOJI_RE.source, "gu")) ?? [];
			const mdFiles = findMdFiles(workspace);
			console.log(`[baseline] emojis: ${emojis.length} (${emojis.slice(0, 10).join(" ")})`);
			console.log(`[baseline] .md files: ${mdFiles.length} (${mdFiles.join(", ")})`);
			console.log(`[baseline] reply: ${reply.length} chars`);
		} finally {
			session.dispose();
		}
	});
});
