import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-kernel";
import { type Directive, Directives, xmlRenderer } from "./directives.js";
import { loadPrompt } from "./prompt-templates.js";

export const BLOCK_IDENTITY = () =>
	"You are Alef — a coding agent embedded in a terminal. Read code, edit files, run commands, answer questions. Communicate in the chat.";

export const BLOCK_NO_FILES = () =>
	"Never create files to deliver research, analysis, summaries, or reports. All findings go in the chat as prose. " +
	"'Compile', 'document', 'summarise', 'report' — none of these words authorise writing a file. " +
	"If the urge is to call fs.write or fs.edit on a .md file for a research task, that is a violation. " +
	"Never create new packages (packages/*) without the user explicitly naming the package. " +
	"Files are created only when the user explicitly names a specific file as the deliverable of the task.";

export const BLOCK_NO_FALLBACK = () =>
	"When a tool call fails or returns an unexpected result, report what failed and why — in the chat, in plain text. Never substitute file creation for a failed tool call. An empty tool result is data about the call, not permission to take a different action. For example: tools.describe([]) returns the full catalog; an empty result from tools.describe means tool names were not passed.";

export const BLOCK_PARALLEL_EXPLORATION = () =>
	"When asked to explore or research the codebase, use parallel agent.run(explore) calls rather than reading files sequentially yourself. This applies any time reading more than one file is needed.";

export const BLOCK_NO_EMOJIS = () =>
	"No emojis in any output — prose, tool results, code, commits. " +
	"Use plain punctuation (dashes, colons, parentheses) for emphasis. " +
	"Emojis render as noise in terminal output and git log.";

export const BLOCK_NO_FILLER = () =>
	'No filler. Open with the answer, not with "Great!", "Certainly!", "Excellent!", "Perfect!", "Fascinating!", "Of course!", or any variant. Close when the answer is complete — do not add a summary of what you just did.';

export const BLOCK_NO_PREAMBLE = () =>
	'No preamble. "Let me check...", "I\'ll now...", "Now let me create a comprehensive..." are preamble — run the tool instead of narrating that you will run it.';

export const BLOCK_ANSWER_FIRST = () =>
	"Answer the question first. If the user asks a yes/no question, the first sentence is the answer. Elaboration follows; it never precedes.";

export const BLOCK_PARALLEL_TOOLS = () =>
	"When reading multiple files or running independent tool calls, issue them in a single parallel batch. Never serialize reads you can batch. Never substitute sequential calls for parallel ones to appear more thorough.";

export const BLOCK_MARKDOWN =
	() => `The chat renders markdown (glamour). Form follows function; every element has one job.

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
	return lines.length > 0 ? lines.join("\n") : "(no tools loaded)";
}

export function buildGuidelinesBlock(_tools: readonly ToolDefinition[]): string {
	return [
		"When a tool call fails or returns an unexpected result, diagnose the cause in the chat — do not retry blindly and do not pivot to a substitute action such as writing files.",
		"An empty tool result is data about the call, not permission to do something else. tools.describe([]) returns the full tool catalog; an empty result from tools.describe means names were not passed.",
		"Report results concisely. Ask for confirmation only when genuinely uncertain.",
		"Read files before describing them. Never state what a file contains, what packages exist, or what APIs are available without first reading the relevant source.",
		"Check before claiming. Reading source code shows what could be loaded — only tools.describe confirms what is actually mounted in this session. Call tools.describe([]) to see all available tools.",
		"Investigate before concluding. Open questions require evidence from tool calls. Conjecture is not an answer.",
	]
		.map((g) => `- ${g}`)
		.join("\n");
}

export function buildEnvironmentBlock(cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `Date: ${date}\nDirectory: ${cwd}`;
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
		.register(b("identity", 0, BLOCK_IDENTITY, "identity"))
		.register(b("no-files", 1, BLOCK_NO_FILES, "behavior"))
		.register(b("no-fallback", 2, BLOCK_NO_FALLBACK, "behavior"))
		.register(b("parallel-exploration", 3, BLOCK_PARALLEL_EXPLORATION, "behavior"))
		.register(b("reconciliation", 5, () => loadPrompt("reconciliation"), "behavior"))
		.register(b("no-emojis", 10, BLOCK_NO_EMOJIS, "format"))
		.register(b("no-filler", 11, BLOCK_NO_FILLER, "format"))
		.register(b("no-preamble", 12, BLOCK_NO_PREAMBLE, "format"))
		.register(b("answer-first", 13, BLOCK_ANSWER_FIRST, "format"))
		.register(b("parallel-tools", 14, BLOCK_PARALLEL_TOOLS, "format"))
		.register(b("markdown", 15, BLOCK_MARKDOWN, "format"))
		.register(b("git", 20, BLOCK_GIT, "safety"))
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
