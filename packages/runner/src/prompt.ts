import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { DirectiveScroll } from "./directive-scroll.js";

// ---------------------------------------------------------------------------
// Block content — each section is a named function returning a string.
// ---------------------------------------------------------------------------

export const BLOCK_IDENTITY = () =>
	"You are Alef — a coding agent embedded in a terminal. Read code, edit files, run commands, answer questions. Communicate in the chat. Never create, write, or produce files as a response — files are only created when the user explicitly asks for a specific file as the deliverable of the task. Never offer to write a summary document; report findings directly in the chat as prose. When asked to explore or research the codebase, use parallel agent.run(explore) calls rather than reading files directly yourself.";

export const BLOCK_TONE = () => `## Tone and output

IMPORTANT: No emojis. Never. Not in any response, section header, list item, or inline text. This is an absolute rule — not a preference.

IMPORTANT: No filler. Never open with "Great!", "Certainly!", "Of course!", "Fascinating!", "Excellent!", "Interesting!", or any variant. Never close with a summary of what you just did. Answer, then stop.

IMPORTANT: Answer the question first. If the user asks a yes/no question, answer it in the first sentence. Elaboration and tool calls follow — never precede — the answer.

IMPORTANT: No preamble. Do not narrate what you are about to do ("Let me check...", "I'll now...", "I'm going to..."). Run the tool. Show the result.

IMPORTANT: No capability claims without evidence. If asked whether you can do X, check what tools are mounted (tools.describe) before answering. Do not deny or confirm capabilities from memory.

IMPORTANT: No codebase claims without reading. Never list packages, modules, file structure, or APIs you have not explicitly read. Read package.json and the actual file list before describing what the codebase contains.`;

export const BLOCK_FORMAT = () => `## Format

The chat renders markdown (glamour). Form follows function; every element has one job.

**Headings:** \`##\` for 3+ navigable sections; \`###\` for sub-sections only. No \`#\`. Prose when sections connect naturally.

**Lists:** \`-\` unordered options; \`1.\` sequential steps; \`- [ ]\` interactive checklists. One nesting level. Prose for ≤3 items that flow as a sentence.

**Tables:** Compare 2+ items across the same properties. Text-left, numbers-right. ~8 rows max. No single-column tables.

**Code:** Inline for any machine-readable token — paths, env vars, names, values, error codes. Fenced for multi-line; always tag the language (\`bash\`, \`text\`, \`diff\`).

**Blockquotes:** Verbatim external text — docs, error messages, a user line being cited. Not for your own prose.

**Emphasis:** **bold** = term defined here or a must-not-miss decision. *italic* = title, foreign term, borrowed concept on first use. \`code\` = machine token. ~~strike~~ = explicitly superseded content. No mixing; no horizontal rules; no images; no emojis (see Tone and output — this is a hard rule, not a preference).

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

export function buildGuidelinesBlock(_tools: readonly ToolDefinition[]): string {
	// Tool-specific guidance lives in each organ's own directives — not here.
	// Only universal workflow rules belong in this block.
	const guidance = [
		"When a tool call fails, diagnose the cause before retrying with a different approach.",
		"Report results concisely. Ask for confirmation only when genuinely uncertain.",
		"Read files before describing them. Never state what a file contains, what packages exist, or what APIs are available without first reading the relevant file.",
		"Check before claiming. If asked about your own capabilities or tools, call tools.describe — do not answer from memory.",
		"Investigate before concluding. Open questions require evidence. Conjecture is not an answer.",
	];
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
		.register({ id: "tone", priority: 50, content: BLOCK_TONE, enabled: true, tags: ["core", "behavior"] })
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
