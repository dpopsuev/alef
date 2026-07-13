const PREVIEW_LINE_MAX_CHARS = 70;

const SKIPPED_TYPES = new Set([
	"adapter.loaded",
	"llm.chunk",
	"llm.checkpoint",
	"llm.thinking",
	"context.assemble",
	"llm.tool-chunk",
	"llm.token-usage",
]);

/**
 *
 */
export type DisplayBlock =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; name: string; summary?: string }
	| { kind: "plan"; phase: string; desired: string; lines: string[] }
	| { kind: "state"; label: string; text: string };

/**
 *
 */
export interface PlanPreviewInput {
	phase: string;
	desired: string;
	current?: string;
	stepSummary?: string;
}

/**
 *
 */
export interface ProjectSessionOptions {
	plan?: PlanPreviewInput;
}

/**
 *
 */
export interface SessionRecordProjection {
	bus: string;
	type: string;
	payload: Record<string, unknown>;
}

/**
 *
 */
function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 *
 */
function previewText(text: string): string {
	return collapseWhitespace(text).slice(0, PREVIEW_LINE_MAX_CHARS);
}

/**
 *
 */
function firstStringField(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.path === "string" && payload.path) {
		return payload.path;
	}
	for (const value of Object.values(payload)) {
		if (typeof value === "string" && value) {
			return value;
		}
	}
	return undefined;
}

/**
 *
 */
function planBlockFromInput(plan: PlanPreviewInput): DisplayBlock {
	const lines: string[] = [];
	if (plan.current) {
		lines.push(plan.current);
	}
	if (plan.stepSummary) {
		lines.push(plan.stepSummary);
	}
	return { kind: "plan", phase: plan.phase, desired: plan.desired, lines };
}

/**
 *
 */
function projectRecord(record: SessionRecordProjection): DisplayBlock | undefined {
	const { bus, type, payload } = record;
	if (SKIPPED_TYPES.has(type)) {
		return undefined;
	}

	if (bus === "event" && type === "llm.input") {
		const text = typeof payload.text === "string" ? collapseWhitespace(payload.text) : "";
		return text ? { kind: "user", text } : undefined;
	}

	if ((bus === "notification" && type === "llm.result") || (bus === "command" && type === "llm.response")) {
		const text = typeof payload.text === "string" ? collapseWhitespace(payload.text) : "";
		return text ? { kind: "assistant", text } : undefined;
	}

	if (bus === "command" && !type.startsWith("llm.") && !type.startsWith("context.")) {
		const summary = firstStringField(payload);
		return summary ? { kind: "tool", name: type, summary } : { kind: "tool", name: type };
	}

	return undefined;
}

/**
 *
 */
export function projectSessionRecords(
	records: readonly SessionRecordProjection[],
	options?: ProjectSessionOptions,
): DisplayBlock[] {
	const blocks: DisplayBlock[] = [];
	if (options?.plan) {
		blocks.push(planBlockFromInput(options.plan));
	}
	for (const record of records) {
		const block = projectRecord(record);
		if (block) {
			blocks.push(block);
		}
	}
	return blocks;
}

/**
 *
 */
function blockToLines(block: DisplayBlock): string[] {
	switch (block.kind) {
		case "plan": {
			const header = previewText(`◆ plan [${block.phase}] ${block.desired}`);
			const lines = [`  ${header}`];
			for (const step of block.lines) {
				lines.push(`    ${previewText(step)}`);
			}
			return lines;
		}
		case "user":
			return [`  ▸ ${previewText(block.text)}`];
		case "assistant":
			return [`  ◂ ${previewText(block.text)}`];
		case "tool":
			return block.summary
				? [`  ● ${block.name} ${previewText(block.summary)}`]
				: [`  ● ${block.name}`];
		case "state":
			return [`  ▨ ${block.label}: ${previewText(block.text)}`];
	}
}

/**
 * Keep plan/state blocks plus the last `maxTurns` user turns (tools between them included).
 * Shared by session resume and picker preview so both hosts see the same slice.
 */
export function selectTranscriptBlocks(blocks: readonly DisplayBlock[], maxTurns: number): DisplayBlock[] {
	const turnCount = Math.max(1, maxTurns);
	const planBlocks = blocks.filter((block) => block.kind === "plan" || block.kind === "state");
	const transcript = blocks.filter((block) => block.kind !== "plan" && block.kind !== "state");

	let usersSeen = 0;
	const kept: DisplayBlock[] = [];
	for (let i = transcript.length - 1; i >= 0; i--) {
		const block = transcript[i]!;
		kept.push(block);
		if (block.kind === "user") {
			usersSeen++;
			if (usersSeen >= turnCount) break;
		}
	}
	kept.reverse();
	return [...planBlocks, ...kept];
}

const EVENTS_PER_TURN_ESTIMATE = 8;
const MIN_EVENT_WINDOW = 40;

/** Event-fetch window size for turn-bounded transcript projection (resume + preview). */
export function eventWindowForTurns(turns: number): number {
	return Math.max(Math.max(1, turns) * EVENTS_PER_TURN_ESTIMATE, MIN_EVENT_WINDOW);
}

/**
 * Plain-text host of display blocks (tests / non-TUI). Prefer ChatLog hosting for UI.
 */
export function formatPreviewLines(blocks: readonly DisplayBlock[], maxLines: number): string[] {
	const planBlocks = blocks.filter((block): block is Extract<DisplayBlock, { kind: "plan" }> => block.kind === "plan");
	const otherBlocks = blocks.filter((block) => block.kind !== "plan");

	const planLines = planBlocks.flatMap(blockToLines);
	const otherLines = otherBlocks.flatMap(blockToLines);

	if (planLines.length > 0) {
		const transcriptBudget = Math.max(0, maxLines - planLines.length);
		return [...planLines, ...otherLines.slice(-transcriptBudget)];
	}

	return otherLines.slice(-maxLines);
}
