/**
 * Thinking budget arithmetic — shared by providers that support token-based
 * extended thinking (Anthropic, Amazon Bedrock).
 *
 * Extracted from base-options.ts.
 */

import type { ThinkingBudgets, ThinkingLevel } from "../types.js";

/**
 * Clamp "xhigh" to "high" — the budget table has no xhigh entry.
 * The lossiness is intentional: callers that need xhigh for adaptive thinking
 * models (e.g. Opus 4.6) use effort-based paths, not budget-based paths.
 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
	return effort === "xhigh" ? "high" : effort;
}

/**
 * Derive the thinking budget and adjusted maxTokens for budget-based models.
 * Adaptive thinking models (Opus 4.6+, Sonnet 4.6) use effort levels instead;
 * this function is for older Claude / Bedrock models.
 */
export function adjustMaxTokensForThinking(
	baseMaxTokens: number,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
