import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { DirectiveScroll } from "./directive-scroll.js";

// ---------------------------------------------------------------------------
// Block content — each section is a named function returning a string.
// ---------------------------------------------------------------------------

export const BLOCK_IDENTITY = () =>
	"You are Alef — a coding agent embedded in a terminal. Read code, edit files, run commands, answer questions. Communicate in the chat. Never create, write, or produce files as a response — files are only created when the user explicitly asks for a specific file as the deliverable of the task. Never offer to write a summary document; report findings directly in the chat as prose. When asked to explore or research the codebase, use parallel agent.run(explore) calls rather than reading files directly yourself.";

export const BLOCK_FORMAT = () => `## Format

The chat renders markdown (glamour). Form follows function; every element has one job.

**Headings:** \`##\` for 3+ navigable sections; \`###\` for sub-sections only. No \`#\`. Prose when sections connect naturally.

**Lists:** \`-\` unordered options; \`1.\` sequential steps; \`- [ ]\` interactive checklists. One nesting level. Prose for ≤3 items that flow as a sentence.

**Tables:** Compare 2+ items across the same properties. Text-left, numbers-right. ~8 rows max. No single-column tables.

**Code:** Inline for any machine-readable token — paths, env vars, names, values, error codes. Fenced for multi-line; always tag the language (\`bash\`, \`text\`, \`diff\`).

**Blockquotes:** Verbatim external text — docs, error messages, a user line being cited. Not for your own prose.

**Emphasis:** **bold** = term defined here or a must-not-miss decision. *italic* = title, foreign term, borrowed concept on first use. \`code\` = machine token. ~~strike~~ = explicitly superseded content. No mixing; no horizontal rules; no images; no emojis.

**Glyphs** (for states and pipeline steps): ■ done  ● active  ▲ error  ○ pending  ▸ user  ▪ item`;

export const BLOCK_GIT = () => `## Git

Stage only your changed files with \`git add <path>\`. Pre-commit hooks are mandatory — wait for them. Avoid index-global operations: \`--no-verify\`, \`reset\`, \`checkout .\`, \`clean -f\`, \`stash\`, \`add -A\`.`;

export function buildToolsBlock(tools: readonly ToolDefinition[]): string {
	const lines = tools.map((t) => {
		const desc = t.description ? ` — ${t.description.split(".")[0]}` : "";
		return `- ${t.name}${desc}`;
	});
	return `## Tools\n\n${lines.length > 0 ? lines.join("\n") : "(no tools loaded)"}`;
}

export function buildGuidelinesBlock(tools: readonly ToolDefinition[]): string {
	const names = new Set(tools.map((t) => t.name));
	const hasFs = names.has("fs.read") || names.has("fs.write");
	const hasShell = names.has("shell.exec");
	const hasWeb = names.has("web.fetch") || names.has("web.search");
	const hasNodesh = names.has("nodesh.run");

	const guidance: string[] = [];
	if (hasFs) {
		guidance.push("Read a file before editing it.");
		guidance.push("Use fs.edit for targeted changes; fs.write only when creating or fully rewriting.");
	}
	if (hasShell) {
		guidance.push("Use shell.exec for compilation, tests, and git — not for reading files.");
		if (hasFs) guidance.push("Prefer fs.read over shell.exec when reading files.");
	}
	if (hasWeb) guidance.push("Use web.fetch for a known URL; web.search to discover URLs.");
	if (hasNodesh)
		guidance.push("Use nodesh.run for structured computation, JSON transformation, and Alef API introspection.");
	if (names.has("agent.run"))
		guidance.push(
			"For codebase exploration, research, and parallel read tasks: use multiple agent.run(explore) calls. Do not read files sequentially yourself when a subagent can do it faster.",
		);
	guidance.push("When a tool call fails, diagnose the cause before retrying with a different approach.");
	guidance.push("Report results concisely. Ask for confirmation only when genuinely uncertain.");

	return `## Guidelines\n\n${guidance.map((g) => `- ${g}`).join("\n")}`;
}

export function buildEnvironmentBlock(cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `Date: ${date}\nDirectory: ${cwd}`;
}

// ---------------------------------------------------------------------------
// DirectiveScroll factory — registers all built-in blocks.
// ---------------------------------------------------------------------------

export interface CreateScrollOptions {
	tools: readonly ToolDefinition[];
	cwd: string;
}

export function createDefaultScroll(opts: CreateScrollOptions): DirectiveScroll {
	const { tools, cwd } = opts;
	const scroll = new DirectiveScroll();

	scroll
		.register({ id: "identity", priority: 0, content: BLOCK_IDENTITY, enabled: true, tags: ["core"] })
		.register({ id: "format", priority: 100, content: BLOCK_FORMAT, enabled: true, tags: ["core", "style"] })
		.register({ id: "git", priority: 200, content: BLOCK_GIT, enabled: true, tags: ["core", "safety"] })
		.register({
			id: "tools",
			priority: 300,
			content: () => buildToolsBlock(tools),
			enabled: true,
			tags: ["core", "dynamic"],
		})
		.register({
			id: "guidelines",
			priority: 400,
			content: () => buildGuidelinesBlock(tools),
			enabled: true,
			tags: ["core", "dynamic"],
		})
		.register({
			id: "environment",
			priority: 1000,
			content: () => buildEnvironmentBlock(cwd),
			enabled: true,
			tags: ["core", "ephemeral"],
		});

	return scroll;
}

// ---------------------------------------------------------------------------
// Workspace + organ loading — replaces DirectiveContextAssembler.
// ---------------------------------------------------------------------------

export async function loadWorkspace(scroll: DirectiveScroll, cwd: string): Promise<void> {
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
				scroll.register({ id: `workspace.${file}`, priority: 500, content, enabled: true, tags: ["workspace"] });
			}
		} catch {
			// skip unreadable files
		}
	}
}

export function registerOrgans(scroll: DirectiveScroll, organs: readonly Organ[]): void {
	for (const organ of organs) {
		if (!organ.directives?.length) continue;
		const header = organ.description ? `### ${organ.name}: ${organ.description}` : `### ${organ.name}`;
		const body = organ.directives.map((d) => d.trim()).join("\n\n");
		scroll.register({
			id: `organ.${organ.name}`,
			priority: 600,
			content: `${header}\n\n${body}`,
			enabled: true,
			tags: ["organ"],
		});
	}
}

// ---------------------------------------------------------------------------
// Backward-compat shims — old callers still compile.
// ---------------------------------------------------------------------------

export interface BuildSystemPromptOptions {
	tools: readonly ToolDefinition[];
}

/** @deprecated Use createDefaultScroll() instead. */
export function buildSystemPrompt(opts: BuildSystemPromptOptions = { tools: [] }): string {
	return createDefaultScroll({ tools: opts.tools, cwd: process.cwd() }).build();
}

/** @deprecated Environment is now the 'environment' block at priority 1000. */
export function appendEnvironment(prompt: string, cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `${prompt}\n\nDate: ${date}\nDirectory: ${cwd}`;
}
