/**
 * System prompt construction and project context loading
 */

import {
	assembleDirectiveContext,
	type DirectiveAssemblyAudit,
	type DirectiveEventContext,
	type DirectiveRuntimeMetadata,
	type RuntimeDirective,
} from "@dpopsuev/alef-agent-runtime";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { getCoreOrganToolNames } from "./core-organs.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const DEFAULT_SELECTED_TOOLS = getCoreOrganToolNames("root");

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: core fs/shell/lector organ tool set. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Optional directives layered above base prompt in deterministic order. */
	directives?: RuntimeDirective[];
	/** Optional event digest injected into prompt context. */
	eventContext?: DirectiveEventContext[];
	/** Runtime metadata attached by the runtime/cerebrum composition layer. */
	runtimeMetadata?: DirectiveRuntimeMetadata;
	/** Optional callback to consume deterministic directive application audit. */
	onDirectiveAudit?: (audit: DirectiveAssemblyAudit) => void;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		directives,
		eventContext,
		runtimeMetadata,
		onDirectiveAudit,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("file_read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		const assembled = assembleDirectiveContext({
			basePrompt: prompt,
			directives,
			eventContext,
			runtimeMetadata: {
				...runtimeMetadata,
				tools: runtimeMetadata?.tools ?? selectedTools,
			},
		});
		onDirectiveAudit?.(assembled.audit);
		return assembled.prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || DEFAULT_SELECTED_TOOLS;
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("file_bash");
	const hasGrep = tools.includes("file_grep");
	const hasFind = tools.includes("file_find");
	const hasLs = false; // file_ls removed — file_find(depth=1) replaces it
	const hasRead = tools.includes("file_read");
	const hasSymbolOutline = tools.includes("symbol_outline");
	const hasSymbolGraph = tools.includes("symbol_graph");
	const hasSymbolCallers = tools.includes("symbol_callers");
	const hasSymbolCallees = tools.includes("symbol_callees");
	const hasSymbolDataflow = tools.includes("symbol_dataflow");

	if (hasSymbolOutline && hasRead) {
		addGuideline(
			"For JavaScript and TypeScript files, start with symbol_outline to map symbol graph boundaries before file_read",
		);
	}
	if (hasSymbolGraph || hasSymbolCallers || hasSymbolCallees || hasSymbolDataflow) {
		addGuideline(
			"Use symbol_graph/symbol_callers/symbol_callees/symbol_dataflow before broad grep when mapping TypeScript call structure",
		);
	}

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use file_bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline(
			"Prefer file_grep/file_find over file_bash for file exploration (faster, respects .gitignore). Use file_find with depth=1 to list directory contents.",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside Alef, a coding agent CLI. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Alef documentation (read only when the user asks about Alef itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), Alef packages (docs/packages.md)
- When working on Alef-related topics, read the docs and examples, and follow .md cross-references before implementing
- Always read Alef documentation .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	const assembled = assembleDirectiveContext({
		basePrompt: prompt,
		directives,
		eventContext,
		runtimeMetadata: {
			...runtimeMetadata,
			tools: runtimeMetadata?.tools ?? tools,
		},
	});
	onDirectiveAudit?.(assembled.audit);
	return assembled.prompt;
}
