/**
 * System prompt construction for Alef.
 *
 * Assembly order (pi-mono pattern — U-shaped attention):
 *   1. Identity (primacy — seen first, retained)
 *   2. Safety constraints (critical, near top)
 *   3. Active tool list (conditional on loaded organs)
 *   4. Tool-conditional guidance (adapts to fs/shell/web presence)
 *   5. Project directives — .alef/directives/*.md (via DirectiveContextAssembler)
 *   6. Organ directives (via DirectiveContextAssembler)
 *   7. Date + cwd LAST (recency — highest attention after identity)
 *
 * The base returned here covers 1–4. The assembler appends 5–6.
 * main.ts appends 7 after asm.build().
 */

import type { ToolDefinition } from "@dpopsuev/alef-spine";

export interface BuildSystemPromptOptions {
	/** All tool definitions from the loaded corpus organs. */
	tools: readonly ToolDefinition[];
}

/** Build the static base prompt. Date+cwd are appended separately by main.ts. */
export function buildSystemPrompt(opts: BuildSystemPromptOptions = { tools: [] }): string {
	const toolNames = new Set(opts.tools.map((t) => t.name));

	const hasFs = toolNames.has("fs.read") || toolNames.has("fs.write");
	const hasShell = toolNames.has("shell.exec");
	const hasWeb = toolNames.has("web.fetch") || toolNames.has("web.search");
	const hasNodesh = toolNames.has("nodesh.run");

	// Tool list: one-liner per tool, conditional on what is loaded.
	const toolLines = opts.tools.map((t) => {
		const desc = t.description ? ` — ${t.description.split(".")[0]}` : "";
		return `- ${t.name}${desc}`;
	});
	const toolsList = toolLines.length > 0 ? toolLines.join("\n") : "(no tools loaded)";

	// Tool-conditional guidance.
	const guidance: string[] = [];

	if (hasFs) {
		guidance.push("Always read a file before editing it. Never guess its contents.");
		guidance.push("Use fs.edit for targeted changes. Use fs.write only when creating a file or rewriting entirely.");
	}
	if (hasShell) {
		guidance.push("Use shell.exec for compilation, tests, and git commands — not for reading files.");
		if (hasFs) guidance.push("Prefer fs.read over shell.exec for reading files.");
	}
	if (hasWeb) {
		guidance.push("Use web.fetch for fetching a known URL. Use web.search when you need to discover URLs.");
	}
	if (hasNodesh) {
		guidance.push("Use nodesh.run for structured computation, JSON transformation, and Alef API introspection.");
	}

	guidance.push("If a tool call fails, diagnose why before retrying. Do not re-attempt the exact same call.");
	guidance.push("Report results concisely. Do not ask for confirmation unless genuinely uncertain.");

	const guidelineBlock = guidance.map((g) => `- ${g}`).join("\n");

	return `You are a precise coding assistant operating inside Alef, a self-improving agent harness. You help users by reading files, editing code, running commands, and writing new files.

## Safety & Git Constraints

IMPORTANT: These rules protect ongoing multi-agent work.
- NEVER use git commit --no-verify. Pre-commit checks are mandatory.
- NEVER use git reset, git checkout, git clean, git stash, git add -A, or git add . — these destroy other agents' changes.
- NEVER use git reset HEAD~ unless explicitly requested.
- If pre-commit hooks are slow, wait. Never bypass them.
- Stage only the specific files you changed: git add <file1> <file2>

## Active Tools

${toolsList}

## Guidelines

${guidelineBlock}`;
}

/** Append date and cwd last (recency position — highest LLM attention after identity). */
export function appendEnvironment(prompt: string, cwd: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `${prompt}\n\nCurrent date: ${date}\nCurrent working directory: ${cwd}`;
}
