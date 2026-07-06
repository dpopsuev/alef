/**
 * JudgingAdapter — the only write tool a judge agent receives.
 *
 * Exposes a single tool: report.submit
 * Typed schema enforces structured output from the judge.
 * The adapter captures the submission via an event emitter so the
 * JudgePanelRunner can read it after the judge's session ends.
 */

import {
	type Adapter,
	defineAdapter,
	type ToolDefinition,
	typedAction,
} from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Report schema
// ---------------------------------------------------------------------------

export const FindingSeveritySchema = z.enum(["critical", "major", "minor", "suggestion"]);
/**
 *
 */
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const JudgeFindingSchema = z.object({
	severity: FindingSeveritySchema,
	/** File and optional line: "src/sum.ts:12" or just "src/sum.ts". */
	location: z.string().optional(),
	// eslint-disable-next-line no-magic-numbers
	message: z.string().max(300),
});
/**
 *
 */
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>;

export const JudgeVerdictSchema = z.enum(["approve", "request-changes", "comment"]);
/**
 *
 */
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeReportSchema = z.object({
	/** 0.0–1.0. Determines weighted contribution to Score 2. */
	score: z.number().min(0).max(1),
	verdict: JudgeVerdictSchema,
	/** One-sentence headline visible in the summary table. Max 200 chars. */
	// eslint-disable-next-line no-magic-numbers
	summary: z.string().max(200),
	/** Up to 10 specific findings with severity and location. */
	// eslint-disable-next-line no-magic-numbers
	findings: z.array(JudgeFindingSchema).max(10),
});
/**
 *
 */
export type JudgeReport = z.infer<typeof JudgeReportSchema>;

const SUBMIT_TOOL: ToolDefinition = {
	name: "report.submit",
	description:
		"Submit your review report. Call this exactly once when your analysis is complete. " +
		"score: 0.0=blocking 0.4=major-issues 0.7=minor-issues 1.0=approve. " +
		"findings: specific file:line observations with severity.",
	inputSchema: JudgeReportSchema,
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 *
 */
export interface JudgingAdapterOptions {
	onReport(report: JudgeReport): void;
}

/**
 *
 */
export function createJudgingAdapter(opts: JudgingAdapterOptions): Adapter {
	return defineAdapter(
		"judging",
		{
			command: {
				"report.submit": typedAction(SUBMIT_TOOL, (ctx) => {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload validated by Zod inputSchema before reaching handler
					const report = ctx.payload as JudgeReport;
					opts.onReport(report);
					const text = `Report submitted. Score: ${report.score.toFixed(2)}. Verdict: ${report.verdict}.`;
					return Promise.resolve(withDisplay({ submitted: true }, { text, mimeType: "text/plain" }));
				}),
			},
		},
		{
			description: "Submit a structured code review report via report.submit.",
			directives: [
				"Use report.submit exactly once when your analysis is complete. " +
					"Score 0.0 for blocking issues, 1.0 to approve. " +
					"Include specific file:line findings with severity.",
			],
		},
	);
}
