/**
 * RunMetrics — collected after each scenario run.
 *
 * Source: OTel spans from InMemorySpanExporter + EvaluatorOrgan observations.
 */

export interface SpanRecord {
	name: string;
	attributes: Record<string, unknown>;
	status: "OK" | "ERROR" | "UNSET";
	durationMs: number;
	/** Tool call input args, if captured from the span event. */
	args?: Record<string, unknown>;
	/** Tool call result text, if captured from the span event. */
	result?: string;
}

/**
 * Structured record for a single LLM call within a run.
 * Populated from OTel spans emitted by organ-llm.
 * Mirrors Tako cerebrum.TurnRecord.
 */
export interface TurnRecord {
	/** 1-based turn index within the run. */
	turn: number;
	/** LLM model id (gen_ai.request.model). */
	model: string;
	/** Input tokens consumed (gen_ai.usage.input_tokens). */
	tokensIn: number;
	/** Output tokens produced (gen_ai.usage.output_tokens). */
	tokensOut: number;
	/** Cache read tokens (gen_ai.usage.cache_read_tokens). */
	cacheReadTokens: number;
	/** Estimated cost in USD (alef.estimated_cost_usd). */
	estimatedCostUsd: number;
	/** Number of tool calls dispatched from this LLM response. */
	toolCalls: number;
	/** Names of tools called in this turn (from alef.motor/* spans after this LLM span). */
	toolNames: string[];
	/** Cache hits for tool calls dispatched from this turn. */
	cacheHits: number;
	/** Wall-clock duration of the LLM call in ms. */
	elapsedMs: number;
}

/**
 * Derive TurnRecord[] from a flat SpanRecord array.
 * LLM call spans (name starts with 'chat ') are the anchors;
 * motor spans following each LLM call are attributed to that turn.
 */
export function deriveturns(spans: SpanRecord[]): TurnRecord[] {
	const turns: TurnRecord[] = [];
	let turnIndex = 0;

	for (let i = 0; i < spans.length; i++) {
		const s = spans[i];
		if (!s.name.startsWith("chat ")) continue;

		turnIndex++;
		// Collect motor tool spans that follow this LLM call until the next LLM call
		const toolSpans: SpanRecord[] = [];
		for (let j = i + 1; j < spans.length; j++) {
			if (spans[j].name.startsWith("chat ")) break;
			if (spans[j].name.startsWith("alef.motor/")) toolSpans.push(spans[j]);
		}

		const toolNames = toolSpans.map((ts) => ts.name.replace("alef.motor/", "")).filter((n) => n !== "dialog.message");

		turns.push({
			turn: turnIndex,
			model: String(s.attributes["gen_ai.request.model"] ?? ""),
			tokensIn: Number(s.attributes["gen_ai.usage.input_tokens"] ?? 0),
			tokensOut: Number(s.attributes["gen_ai.usage.output_tokens"] ?? 0),
			cacheReadTokens: Number(s.attributes["gen_ai.usage.cache_read_tokens"] ?? 0),
			estimatedCostUsd: Number(s.attributes["alef.estimated_cost_usd"] ?? 0),
			toolCalls: toolNames.length,
			toolNames,
			cacheHits: toolSpans.filter((ts) => ts.attributes["alef.cache.hit"] === true).length,
			elapsedMs: Math.round(s.durationMs),
		});
	}

	return turns;
}

export interface RunMetrics {
	/** Scenario identifier. */
	scenario: string;
	/**
	 * Absolute path to the workspace directory.
	 * Only populated when HarnessOptions.keepWorkspace is true.
	 * Undefined otherwise (workspace already cleaned up).
	 */
	workspace?: string;
	/**
	 * Per-LLM-call structured records.
	 * Populated automatically by EvalHarness from OTel spans.
	 * Mirrors Tako cerebrum.TurnRecord.
	 */
	turns: TurnRecord[];
	/**
	 * Full conversation transcript: the complete messages array at end of the eval run.
	 * Each entry is { role, content, toolCallId?, toolName?, isError? }.
	 * Populated from the conversationHistory field on the last Motor dialog.message event.
	 *
	 * Anthropic: "A transcript is the complete record of a trial, including outputs,
	 * tool calls, reasoning, and intermediate results."
	 */
	transcript: Array<Record<string, unknown>>;
	/** true if the agent produced the expected output without errors. */
	passed: boolean;
	/** Error message if passed=false. */
	error?: string;
	/** Total Motor+Sense events observed. */
	totalEvents: number;
	/** Total alef.motor/* and alef.sense/* spans. */
	totalSpans: number;
	/** Spans where alef.cache.hit=true. */
	cacheHits: number;
	/** Spans where alef.cache.hit=false (actual handle() calls). */
	cacheMisses: number;
	/** Optimal Action Efficiency: cacheHits / totalSpans (0–1). */
	oae: number;
	/** true if EvaluatorOrgan detected a tool call loop. */
	loopDetected: boolean;
	/** Event type that looped, if any. */
	loopEventType?: string;
	/** All collected spans. */
	spans: SpanRecord[];
	/** Wall-clock duration of the full run. */
	durationMs: number;
}

/**
 * Scoring rule applied per span.
 * Returns a numeric delta (positive = good, negative = bad).
 */
export interface ScoringRule {
	/** Span name pattern (substring match). */
	match: string;
	/** Points to add when matched. Can be negative. */
	points: number;
	/** Optional attribute filter — only score if attribute equals value. */
	attribute?: { key: string; value: unknown };
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/**
 * Pearson correlation coefficient between two equal-length numeric arrays.
 * Returns 0 when n < 2 or one array has zero variance.
 * Range: [-1, 1]. Positive = correlated, 0 = uncorrelated, -1 = anti-correlated.
 *
 * Primary use: confidence_calibration — does the agent's self-reported
 * confidence correlate with whether it actually got the answer right?
 *
 * Mirrors Tako calibrate.batch_correlation.
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return 0;

	const meanX = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
	const meanY = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;

	let num = 0;
	let denX = 0;
	let denY = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - meanX;
		const dy = ys[i] - meanY;
		num += dx * dy;
		denX += dx * dx;
		denY += dy * dy;
	}

	const den = Math.sqrt(denX * denY);
	return den === 0 ? 0 : num / den;
}

/**
 * Compute Pearson r between two named fields across a batch of EvaluationResults.
 * Fields are extracted from metrics.spans attributes.
 *
 * @param field1 - Span attribute key for x-axis (e.g. "alef.confidence")
 * @param field2 - Span attribute key for y-axis (e.g. "alef.correct")
 * @param results - Array of EvaluationResults from RunN()
 */
export function batchCorrelation(field1: string, field2: string, results: Array<{ metrics: RunMetrics }>): number {
	const xs: number[] = [];
	const ys: number[] = [];

	for (const r of results) {
		for (const span of r.metrics.spans) {
			const x = span.attributes[field1];
			const y = span.attributes[field2];
			if (typeof x === "number" && typeof y === "number") {
				xs.push(x);
				ys.push(y);
			}
		}
	}

	return pearsonCorrelation(xs, ys);
}

/** Standard ReadOnly scoring rules — agent should read more than it writes. */
export const READ_ONLY_RULES: ScoringRule[] = [
	{ match: "alef.motor/fs.read", points: 10 },
	{ match: "alef.motor/fs.grep", points: 5 },
	{ match: "alef.motor/fs.find", points: 3 },
	{ match: "alef.motor/fs.write", points: -15 },
	{ match: "alef.motor/fs.edit", points: -15 },
	{ match: "alef.motor/shell.exec", points: -5 },
];

/** Standard Write scoring rules — writes are expected and rewarded. */
export const WRITE_RULES: ScoringRule[] = [
	{ match: "alef.motor/fs.read", points: 5 },
	{ match: "alef.motor/fs.grep", points: 3 },
	{ match: "alef.motor/fs.write", points: 15 },
	{ match: "alef.motor/fs.edit", points: 10 },
];

export function scoreSpans(spans: SpanRecord[], rules: ScoringRule[]): number {
	let total = 0;
	for (const span of spans) {
		for (const rule of rules) {
			if (!span.name.includes(rule.match)) continue;
			if (rule.attribute) {
				const val = span.attributes[rule.attribute.key];
				if (val !== rule.attribute.value) continue;
			}
			total += rule.points;
		}
	}
	return total;
}
