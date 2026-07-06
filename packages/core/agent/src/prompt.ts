import { hostname } from "node:os";
import { type Directive, Directives, xmlRenderer } from "@dpopsuev/alef-agent/directives";
import { loadPrompt } from "@dpopsuev/alef-agent/prompt-templates";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";

export const BLOCK_CORE = () =>
	`You are Alef, a coding agent in a terminal. You help by reading code, editing files, running commands, and answering questions.

Do not create files unless they are necessary for the task. Prefer editing existing files over creating new ones. This includes markdown files. All research, analysis, and reports go in the chat as prose — not as files.

When a tool call fails, report the error in the chat. Do not retry blindly and do not pivot to file creation as a fallback.

Use parallel agent.run(explore) calls for multi-file codebase exploration. Batch independent tool calls in a single parallel invocation.

No emojis. No filler openers ("Great!", "Certainly!"). No preamble ("Let me check...") — run the tool instead. Answer the question first; elaboration follows. Be concise.

Stage only changed files with \`git add <path>\`. Pre-commit hooks are mandatory. If a hook fails, fix the underlying error — do not work around it.`;

/**
 *
 */
export function buildToolsBlock(tools: readonly ToolDefinition[]): string {
	const lines = tools.map((t) => {
		const desc = t.description ? ` — ${t.description.split(".")[0]}` : "";
		return `- ${t.name}${desc}`;
	});
	return lines.length > 0 ? lines.join("\n") : "(no tools loaded)";
}

/**
 *
 */
export function buildGuidelinesBlock(_tools: readonly ToolDefinition[]): string {
	return [
		"Read files before describing them. Never state what a file contains without first reading the source.",
		"Call tools.describe([]) to see all available tools. Call tools.describe([name]) for a tool's full schema before using it.",
		"Investigate before concluding. Open questions require evidence from tool calls, not conjecture.",
	]
		.map((g) => `- ${g}`)
		.join("\n");
}

/**
 *
 */
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
		`Session store: ~/.alef/sessions/`,
	].join("\n");
}

/**
 *
 */
export interface CreateScrollOptions {
	tools: readonly ToolDefinition[];
	cwd: string;
}

const PRIORITY_CORE = 0;
const PRIORITY_RECONCILIATION = 5;
const PRIORITY_FORMAT = 10;
const PRIORITY_SAFETY = 15;
const PRIORITY_TOOLS = 100;
const PRIORITY_GUIDELINES = 200;
const PRIORITY_ADAPTER = 600;
const PRIORITY_ENVIRONMENT = 1000;

/**
 *
 */
function b(id: string, priority: number, content: Directive["content"], ...tags: string[]): Directive {
	return { id, priority, content, enabled: true, tags: ["core", ...tags] };
}

/**
 *
 */
export function createDefaultDirectives(opts: CreateScrollOptions): Directives {
	const { tools, cwd } = opts;
	const directives = new Directives();
	directives.renderer = xmlRenderer;

	directives
		.register(b("core", PRIORITY_CORE, BLOCK_CORE, "identity", "behavior", "format", "safety"))
		.register(b("reconciliation", PRIORITY_RECONCILIATION, () => loadPrompt("reconciliation"), "behavior"))
		.register(b("no-emojis", PRIORITY_FORMAT, () => loadPrompt("no-emojis"), "format"))
		.register(b("no-files", PRIORITY_SAFETY, () => loadPrompt("no-files"), "behavior", "safety"))
		.register(b("tools", PRIORITY_TOOLS, () => buildToolsBlock(tools), "dynamic"))
		.register(b("guidelines", PRIORITY_GUIDELINES, () => buildGuidelinesBlock(tools), "dynamic"))
		.register(b("environment", PRIORITY_ENVIRONMENT, () => buildEnvironmentBlock(cwd), "ephemeral"));

	return directives;
}

/**
 *
 */
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

/**
 *
 */
export function registerAdapters(directives: Directives, adapters: readonly Adapter[]): void {
	for (const adapter of adapters) {
		if (!adapter.directives?.length) continue;
		const header = adapter.description ? `### ${adapter.name}: ${adapter.description}` : `### ${adapter.name}`;
		const body = adapter.directives.map((d) => d.trim()).join("\n\n");
		directives.register({
			id: `adapter.${adapter.name}`,
			priority: PRIORITY_ADAPTER,
			content: `${header}\n\n${body}`,
			enabled: true,
			tags: ["adapter"],
		});
	}
}


