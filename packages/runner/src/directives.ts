/**
 * DirectiveContextAssembler — collects Organ.directives from all loaded organs
 * and composes them with the base system prompt.
 *
 * Two-level ACI (Appendix 2 of the Anthropic prompt engineering guide):
 *   Level 1: Tool descriptions — brief one-liner per tool (already in ToolDefinition.description)
 *   Level 2: Organ directives — detailed when/avoid/limits guidance in the system prompt
 *
 * This module owns level 2. It reads `organ.directives` from each loaded organ,
 * deduplicates, and appends them after the base prompt under a clear header.
 *
 * Usage:
 *   const prompt = assembleSystemPrompt(basePrompt, agent.organs);
 */

import type { Organ } from "@dpopsuev/alef-spine";

/**
 * Assemble the full system prompt by appending organ directives after the base.
 * Returns the base prompt unchanged if no organ has directives.
 */
export function assembleSystemPrompt(base: string, organs: readonly Organ[]): string {
	const blocks: string[] = [];

	for (const organ of organs) {
		if (!organ.directives?.length) continue;
		for (const directive of organ.directives) {
			const trimmed = directive.trim();
			if (trimmed) blocks.push(trimmed);
		}
	}

	if (blocks.length === 0) return base;

	return `${base}\n\n## Tool Guidance\n\n${blocks.join("\n\n")}`;
}
