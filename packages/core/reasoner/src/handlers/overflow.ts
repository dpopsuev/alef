/**
 * Four-stage context overflow recovery system.
 *
 * When context overflow occurs, we progressively increase compaction severity:
 * 1. Standard summarization (normal compact)
 * 2. Aggressive summarization (keep last 2 turns)
 * 3. Arg truncation + aggressive summarization
 * 4. Emergency mode (last turn + system prompt only)
 *
 * Each stage attempts one LLM retry. If all stages fail, we surface the error.
 */

import type { Message, UserMessage } from "@dpopsuev/alef-ai/types";

const OVERFLOW_STAGE_STANDARD = 1;
const OVERFLOW_STAGE_AGGRESSIVE = 2;
const OVERFLOW_STAGE_ARG_TRUNCATION = 3;
const OVERFLOW_STAGE_EMERGENCY = 4;
const ARG_TRUNCATION_THRESHOLD_RATIO = 1.5;
const AGGRESSIVE_THRESHOLD_RATIO = 1.2;
const AGGRESSIVE_REDUCTION_TURN_COUNT = 2;

/** Overflow recovery stages in order of severity. */
export enum OverflowStage {
	Standard = OVERFLOW_STAGE_STANDARD,
	Aggressive = OVERFLOW_STAGE_AGGRESSIVE,
	ArgTruncation = OVERFLOW_STAGE_ARG_TRUNCATION,
	Emergency = OVERFLOW_STAGE_EMERGENCY,
}

/** Instructions for each recovery stage. */
const STAGE_INSTRUCTIONS: Record<OverflowStage, string> = {
	[OverflowStage.Standard]: "Recover from context overflow; preserve goals, paths, and decisions.",
	[OverflowStage.Aggressive]:
		"Aggressive compaction: summarize aggressively, keep only last 2 turns verbatim.",
	[OverflowStage.ArgTruncation]:
		"Emergency compaction: truncate all tool arguments, keep only tool names and short summaries.",
	[OverflowStage.Emergency]:
		"Critical compaction: preserve only the most recent user message and essential context.",
};

/** Classify overflow severity based on context usage.
 *
 * Thresholds:
 * - Standard: 5-20% overflow (1.05 - 1.2x)
 * - Aggressive: 20-50% overflow (1.2 - 1.5x)
 * - ArgTruncation: 50-150% overflow (1.5 - 2.5x)
 * - Emergency: >150% overflow (>2.5x)
 */
export function classifyOverflowSeverity(
	contextUsed: number,
	contextWindow: number,
): OverflowStage {
	const ratio = contextUsed / contextWindow;
	// Emergency: Double the context window or more
	if (ratio >= 2.0) return OverflowStage.Emergency;
	// ArgTruncation: 50-100% overflow
	if (ratio > ARG_TRUNCATION_THRESHOLD_RATIO) return OverflowStage.ArgTruncation;
	// Aggressive: 20-50% overflow
	if (ratio > AGGRESSIVE_THRESHOLD_RATIO) return OverflowStage.Aggressive;
	// Standard: 5-20% overflow
	return OverflowStage.Standard;
}

/** Get compaction instructions for a stage. */
export function getStageInstructions(stage: OverflowStage): string {
	return STAGE_INSTRUCTIONS[stage];
}

/** Check if we can escalate to the next stage. */
export function canEscalate(stage: OverflowStage): boolean {
	return stage < OverflowStage.Emergency;
}

/** Escalate to next stage. */
export function escalateStage(stage: OverflowStage): OverflowStage {
	return Math.min(stage + 1, OverflowStage.Emergency);
}

/** Apply aggressive message reduction (keep last 2 turns). */
export function applyAggressiveReduction(messages: Message[]): void {
	if (messages.length <= AGGRESSIVE_REDUCTION_TURN_COUNT) return;
	const kept = messages.slice(-AGGRESSIVE_REDUCTION_TURN_COUNT);
	messages.length = 0;
	messages.push(...kept);
}

/** Truncate tool call arguments in messages. */
export function truncateToolArgs(messages: Message[]): void {
	const MAX_ARG_LENGTH = 200;

	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type !== "toolCall") continue;
				const tc = block;
				const argsStr = JSON.stringify(tc.arguments);
				if (argsStr.length > MAX_ARG_LENGTH) {
					tc.arguments = { _truncated: `[${argsStr.slice(0, MAX_ARG_LENGTH)}...]` };
				}
			}
		}
	}
}

/** Apply emergency reduction (system + last user message only). */
export function applyEmergencyReduction(messages: Message[]): void {
	// Find last user message
	let lastUser: UserMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user") {
			lastUser = message;
			break;
		}
	}

	messages.length = 0;
	if (lastUser) {
		messages.push({
			...lastUser,
			content:
				typeof lastUser.content === "string"
					? lastUser.content
					: [{ type: "text", text: "[Emergency mode: content truncated to avoid overflow]" }],
		});
	} else {
		// No user message found - create a minimal placeholder
		messages.push({
			role: "user",
			content: "Continue from where we left off.",
			timestamp: Date.now(),
		});
	}
}

/** Apply stage-specific transformations to messages. */
export function applyStageTransformation(messages: Message[], stage: OverflowStage): void {
	switch (stage) {
		case OverflowStage.Standard:
			// Standard compaction is handled by context.compact flow, no message mutation
			break;
		case OverflowStage.Aggressive:
			applyAggressiveReduction(messages);
			break;
		case OverflowStage.ArgTruncation:
			truncateToolArgs(messages);
			applyAggressiveReduction(messages);
			break;
		case OverflowStage.Emergency:
			applyEmergencyReduction(messages);
			break;
	}
}
