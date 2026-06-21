import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-kernel";
import { type Directive, Directives, xmlRenderer } from "./directives.js";
import { loadPrompt } from "./prompt-templates.js";

export const BLOCK_CORE = () =>
	`You are Alef, a coding agent in a terminal. You help by reading code, editing files, running commands, and answering questions.

Do not create files unless they are necessary for the task. Prefer editing existing files over creating new ones. This includes markdown files. All research, analysis, and reports go in the chat as prose — not as files.

When a tool call fails, report the error in the chat. Do not retry blindly and do not pivot to file creation as a fallback.

Use parallel agent.run(explore) calls for multi-file codebase exploration. Batch independent tool calls in a single parallel invocation.

No emojis. No filler openers ("Great!", "Certainly!"). No preamble ("Let me check...") — run the tool instead. Answer the question first; elaboration follows. Be concise.

Stage only changed files with \`git add <path>\`. Pre-commit hooks are mandatory. Never bypass them — \`--no-verify\`, \`HUSKY=0\`, \`--no-gpg-sign\`, and \`git commit -n\` are all forbidden. If a hook fails, fix the underlying error — do not work around it.`;

export function buildToolsBlock(tools: readonly ToolDefinition[]): string {
	const lines = tools.map((t) => {
		const desc = t.description ? ` — ${t.description.split(".")[0]}` : "";
		return `- ${t.name}${desc}`;
	});
	return lines.length > 0 ? lines.join("\n") : "(no tools loaded)";
}

export function buildGuidelinesBlock(_tools: readonly ToolDefinition[]): string {
	return [
		"Read files before describing them. Never state what a file contains without first reading the source.",
		"Call tools.describe([]) to see all available tools. Call tools.describe([name]) for a tool's full schema before using it.",
		"Investigate before concluding. Open questions require evidence from tool calls, not conjecture.",
	]
		.map((g) => `- ${g}`)
		.join("\n");
}

export function buildEnvironmentBlock(cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	const pid = process.pid;
	const user = process.env.USER ?? process.env.USERNAME ?? "unknown";
	const host = process.env.HOSTNAME ?? hostname();
	return [
		`Date: ${date}`,
		`Directory: ${cwd}`,
		`PID: ${pid}`,
		`User: ${user}@${host}`,
		`Debug log: ~/.alef/debug.log`,
		`Session store: ~/.alef/sessions/`,
	].join("\n");
}

export interface CreateScrollOptions {
	tools: readonly ToolDefinition[];
	cwd: string;
}

function b(id: string, priority: number, content: Directive["content"], ...tags: string[]): Directive {
	return { id, priority, content, enabled: true, tags: ["core", ...tags] };
}

export function createDefaultDirectives(opts: CreateScrollOptions): Directives {
	const { tools, cwd } = opts;
	const directives = new Directives();
	directives.renderer = xmlRenderer;

	directives
		.register(b("core", 0, BLOCK_CORE, "identity", "behavior", "format", "safety"))
		.register(b("reconciliation", 5, () => loadPrompt("reconciliation"), "behavior"))
		.register(b("no-emojis", 10, () => loadPrompt("no-emojis"), "format"))
		.register(b("no-files", 15, () => loadPrompt("no-files"), "behavior", "safety"))
		.register(b("tools", 100, () => buildToolsBlock(tools), "dynamic"))
		.register(b("guidelines", 200, () => buildGuidelinesBlock(tools), "dynamic"))
		.register(b("environment", 1000, () => buildEnvironmentBlock(cwd), "ephemeral"));

	return directives;
}

export function buildPrepareStep(
	directives: Directives,
	budgetChars: number,
): (messages: { role: string; content: unknown }[]) => Promise<{ role: string; content: unknown }[]> {
	return (messages) => {
		const systemContent = directives.build(budgetChars);
		const withoutSystem = messages.filter((m) => m.role !== "system");
		return Promise.resolve([{ role: "system", content: systemContent }, ...withoutSystem]);
	};
}

export async function loadWorkspace(directives: Directives, cwd: string): Promise<void> {
	// AGENTS.md — industry-standard project instructions for coding agents.
	for (const name of ["AGENTS.md", "agents.md"]) {
		try {
			const content = (await readFile(join(cwd, name), "utf-8")).trim();
			if (content) {
				directives.register({
					id: "agents-md",
					priority: 450,
					content,
					enabled: true,
					tags: ["workspace", "agents-md"],
				});
				break;
			}
		} catch {
			/* absent — continue */
		}
	}

	// .alef/directives/*.md — project-specific directive files.
	const dir = join(cwd, ".alef", "directives");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const file of entries.filter((e) => e.endsWith(".md")).sort()) {
		try {
			const content = (await readFile(join(dir, file), "utf-8")).trim();
			if (content) {
				directives.register({
					id: `workspace.${file}`,
					priority: 500,
					content,
					enabled: true,
					tags: ["workspace"],
				});
			}
		} catch {
			// skip unreadable files
		}
	}
}

export function registerOrgans(directives: Directives, organs: readonly Organ[]): void {
	for (const organ of organs) {
		if (!organ.directives?.length) continue;
		const header = organ.description ? `### ${organ.name}: ${organ.description}` : `### ${organ.name}`;
		const body = organ.directives.map((d) => d.trim()).join("\n\n");
		directives.register({
			id: `organ.${organ.name}`,
			priority: 600,
			content: `${header}\n\n${body}`,
			enabled: true,
			tags: ["organ"],
		});
	}
}

export interface BuildSystemPromptOptions {
	tools: readonly ToolDefinition[];
}

/** @deprecated Use createDefaultDirectives() instead. */
export function buildSystemPrompt(opts: BuildSystemPromptOptions = { tools: [] }): string {
	return createDefaultDirectives({ tools: opts.tools, cwd: process.cwd() }).build();
}

/** @deprecated Environment is now the 'environment' block at priority 1000. */
export function appendEnvironment(prompt: string, cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `${prompt}\n\nDate: ${date}\nDirectory: ${cwd}`;
}
