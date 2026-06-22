/**
 * EvalOrgan — prompt a child Alef and score its responses.
 *
 * Tool: eval.run
 *   endpoint    — from supervisor.spawn
 *   prompts[]   — user/system messages to send in sequence
 *   validators  — structural checks (fast-fail, deterministic)
 *   judgeRubric — natural-language rubric for LLM-as-judge (optional)
 *   judgeThreshold — 0-100 score threshold to pass (default: 70)
 *   timeoutMs   — per-prompt SSE wait (default: 30_000)
 *
 * Phase 1: structural validators — any failure returns immediately without
 * calling the LLM judge.
 * Phase 2: LLM-as-judge — sends transcript + rubric to the configured model,
 * parses a 0-100 score and reasoning string.
 */

import type { Adapter, BaseOrganOptions, MotorHandlerCtx, Nerve } from "@dpopsuev/alef-kernel";
import { defineAdapter, getNumber, getString, typedAction } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { collectEvents, postMessage } from "./http.js";
import type { EvalPrompt, TranscriptEvent, Validator } from "./types.js";
import { runValidators } from "./validators.js";

export interface EvalOrganOptions extends BaseOrganOptions {
	/** Model to use for LLM-as-judge. Defaults to ALEF_MODEL or autoDetect. */
	judgeModel?: string;
	/** Event type for the agent reply. Provided by assembly. */
	replyEvent: string;
}

const PromptSchema = z.object({
	role: z.enum(["user", "system"]),
	text: z.string().min(1),
});

const ValidatorSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("contains"), value: z.string().min(1) }),
	z.object({ type: z.literal("not_contains"), value: z.string().min(1) }),
	z.object({ type: z.literal("tool_called"), value: z.string().min(1) }),
	z.object({ type: z.literal("exit_code"), value: z.string().min(1) }),
]);

const EVAL_TOOL = {
	name: "eval.run",
	description:
		"Send a sequence of prompts to a child Alef endpoint and score the responses. " +
		"Phase 1: structural validators (deterministic, fast-fail). " +
		"Phase 2: LLM-as-judge scores the transcript against a rubric (0-100). " +
		"Returns EvalResult { passed, score, failures, reasoning, transcript }.",
	inputSchema: z.object({
		endpoint: z.string().min(1).describe("Child Alef HTTP endpoint from orchestration.spawn"),
		prompts: z.array(PromptSchema).min(1).describe("Messages to send in sequence"),
		validators: z.array(ValidatorSchema).optional().describe("Structural checks applied before LLM judge"),
		judgeRubric: z
			.string()
			.optional()
			.describe("Natural-language rubric for LLM-as-judge. Omit to skip LLM scoring."),
		judgeThreshold: z.number().min(0).max(100).optional().describe("Min score to pass (default: 70)"),
		timeoutMs: z.number().optional().describe("Per-prompt SSE wait in ms (default: 30_000)"),
	}),
};

async function runLLMJudge(
	transcript: TranscriptEvent[],
	rubric: string,
): Promise<{ score: number; reasoning: string }> {
	const { streamSimple } = await import("@dpopsuev/alef-llm");
	const { autoDetectModel } = await import("../../runner/src/model/index.js").catch(() => ({
		autoDetectModel: () => undefined,
	}));
	const model = autoDetectModel?.();
	if (!model) return { score: 0, reasoning: "No model available for LLM judge" };

	const transcriptText = transcript
		.filter((e) => e.text)
		.map((e) => `[${e.bus}/${e.type}] ${e.text}`)
		.join("\n");

	const judgePrompt = [
		"You are an objective evaluator scoring an AI agent's responses.",
		"",
		`Rubric: ${rubric}`,
		"",
		"Transcript:",
		transcriptText,
		"",
		"Respond with exactly two lines:",
		"Score: <0-100>",
		"Reasoning: <one sentence>",
	].join("\n");

	let output = "";
	const stream = streamSimple(model, {
		messages: [{ role: "user" as const, content: judgePrompt, timestamp: Date.now() }],
	});
	for await (const event of stream) {
		if (event.type === "text_delta") output += event.delta;
	}

	const scoreMatch = output.match(/Score:\s*(\d+)/i);
	const reasoningMatch = output.match(/Reasoning:\s*(.+)/i);
	return {
		score: scoreMatch ? Math.min(100, Math.max(0, Number(scoreMatch[1]))) : 0,
		reasoning: reasoningMatch?.[1]?.trim() ?? output.trim().slice(0, 200),
	};
}

export function createEvalOrgan(opts: EvalOrganOptions): Adapter {
	let nerve: Nerve | null = null;
	const emitSignal = (type: string, payload: Record<string, unknown>) =>
		nerve?.signal.publish({ type, payload, correlationId: "" });

	async function handleEval(ctx: MotorHandlerCtx): Promise<Record<string, unknown>> {
		const endpoint = getString(ctx.payload, "endpoint") ?? "";
		if (!endpoint) throw new Error("eval.run: endpoint is required");
		emitSignal("eval.intent", { text: `scoring ${endpoint}` });

		const promptsRaw = ctx.payload.prompts;
		const prompts: EvalPrompt[] = Array.isArray(promptsRaw) ? (promptsRaw as EvalPrompt[]) : [];

		const validatorsRaw = ctx.payload.validators;
		const validators: Validator[] = Array.isArray(validatorsRaw) ? (validatorsRaw as Validator[]) : [];

		const judgeRubric = getString(ctx.payload, "judgeRubric");
		const judgeThreshold = getNumber(ctx.payload, "judgeThreshold") ?? 70;
		const timeoutMs = getNumber(ctx.payload, "timeoutMs") ?? 30_000;

		// Collect the full transcript across all prompts.
		const transcript: TranscriptEvent[] = [];

		for (const prompt of prompts) {
			if (prompt.role === "system") continue; // system messages configure context, not sent via /message

			// Start SSE collection before posting (avoids race).
			const ssePromise = collectEvents(
				endpoint,
				(events) => events.some((e) => e.bus === "motor" && e.type === opts.replyEvent),
				timeoutMs,
			);

			await postMessage(endpoint, prompt.text);
			const events = await ssePromise;
			transcript.push(...events);
		}

		// Phase 1: structural validators.
		const failures = runValidators(transcript, validators);
		if (failures.length > 0) {
			return { passed: false, score: 0, failures, reasoning: "Structural validation failed", transcript };
		}

		// Phase 2: LLM-as-judge (if rubric provided).
		if (judgeRubric) {
			const { score, reasoning } = await runLLMJudge(transcript, judgeRubric);
			return {
				passed: score >= judgeThreshold,
				score,
				failures: score < judgeThreshold ? [`Score ${score} below threshold ${judgeThreshold}`] : [],
				reasoning,
				transcript,
			};
		}

		// No judge rubric — structural validators alone determine pass.
		return { passed: true, score: 100, failures: [], reasoning: "All structural validators passed", transcript };
	}

	return defineAdapter(
		"eval",
		{
			motor: { "eval.run": typedAction(EVAL_TOOL, handleEval) },
		},
		{
			logger: opts.logger,
			onMount: (n: Nerve) => {
				nerve = n;
			},
			contributions: {
				tui: {
					signals: {
						"eval.intent": (payload, ui) => {
							ui.setIntent(String(payload.text ?? ""));
						},
					},
				},
			},
			description: "Evaluate a child Alef's responses with structural validators and LLM-as-judge.",
			labels: ["eval", "judge", "testing"],
			directives: [
				`**eval organ — scoring child Alef responses**
Use eval.run after supervisor.spawn to validate that a new organ behaves correctly.

Prompt design:
- Write prompts that exercise the organ's intended behaviour directly.
- Include at least one validator per prompt (tool_called, contains, etc.).
- Use judgeRubric for semantic quality checks (correctness, coherence, safety).

Interpreting EvalResult:
- passed: true  → proceed to supervisor.promote
- passed: false → read failures[] and reasoning, rewrite the organ, re-spawn, re-eval
- Never promote if passed is false.`,
			],
		},
	);
}
