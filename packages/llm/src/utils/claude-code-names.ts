/**
 * Claude Code stealth mode — tool name canonicalisation.
 *
 * When a request is authenticated with a Claude Code OAuth token, tool names
 * are normalised to the casing Claude Code uses internally. This makes traffic
 * appear indistinguishable from the official Claude Code client, allowing access
 * to prompt-cache benefits and provider-specific routing.
 *
 * Source for canonical names: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
 * To update:                  https://github.com/badlogic/cchistory
 *
 * Extracted from anthropic.ts.
 */

import type { Tool } from "../types.js";

export const CLAUDE_CODE_VERSION = "2.1.75";

const CLAUDE_CODE_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const CC_TOOL_LOOKUP = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

/** Convert a tool name to Claude Code canonical casing (case-insensitive match). */
export const toClaudeCodeName = (name: string): string => CC_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;

/**
 * Reverse mapping: given an LLM response tool name, find the original tool name
 * from the provided tool list (case-insensitive). Falls back to the raw name.
 */
export const fromClaudeCodeName = (name: string, tools?: Tool[]): string => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matched = tools.find((t) => t.name.toLowerCase() === lowerName);
		if (matched) return matched.name;
	}
	return name;
};
