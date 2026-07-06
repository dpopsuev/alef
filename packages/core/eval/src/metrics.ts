/**
 * RunMetrics — collected after each scenario run.
 *
 * Source: OTel spans from InMemorySpanExporter + EvaluatorAdapter observations
 * + direct Bus event capture via agent.observe().
 */

/**
 * One Command or Event message captured in real-time from the bus.
 * Complements OTel spans: spans only cover completed calls; BusEvents include
 * the in-flight command event that precedes a timeout.
 */
export interface BusEvent {
	bus: "command" | "event" | "notification";
	event: string;
	correlationId: string;
	/** Key payload fields, truncated. Full fidelity for args; first 300 chars for results. */
	payload?: Record<string, unknown>;
	isError?: boolean;
	errorMessage?: string;
	/** Round-trip ms from paired command to this event message. Undefined on command/notification events. */
	elapsedMs?: number;
}

/**
 *
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
 * Populated from OTel spans emitted by the Reasoner.
 * Mirrors Tako TurnRecord.
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
	/** Names of tools called in this turn (from alef.command/* spans after this LLM span). */
	toolNames: string[];
	/** Cache hits for tool calls dispatched from this turn. */
	cacheHits: number;
	/** Wall-clock duration of the LLM call in ms. */
	elapsedMs: number;
	/** Estimated tokens consumed by tool schema definitions on this call (chars/4). */
	schemaTokensEstimate: number;
	/** Number of application-level retries on this turn (0 = no retries). */
	retries: number;
	/** Retry reasons (e.g. 'resource_exhausted', 'overloaded_error'). */
	retryReasons: string[];
	/** True if the LLM call was aborted (scenario timeout or AbortSignal). */
	aborted: boolean;
	/** Reasoner turn number within the LLM loop (1-based). */
	llmTurn: number;
}

/**
 * Derive TurnRecord[] from a flat SpanRecord array.
 * LLM call spans (name starts with 'chat ') are the anchors;
 * command spans following each LLM call are attributed to that turn.
 */
export function deriveturns(spans: SpanRecord[]): TurnRecord[] {
	const turns: TurnRecord[] = [];
	let turnIndex = 0;

	for (let i = 0; i < spans.length; i++) {
		const s = spans[i];
		if (!s.name.startsWith("chat ")) continue;

		turnIndex++;
		// Collect command tool spans that follow this LLM call until the next LLM call
		const toolSpans: SpanRecord[] = [];
		for (let j = i + 1; j < spans.length; j++) {
			if (spans[j].name.startsWith("chat ")) break;
			if (spans[j].name.startsWith("alef.command/")) toolSpans.push(spans[j]);
		}

		// Exclude internal seam events from tool path tracking.
		// context.assemble is ToolShellAdapter's context lifecycle interceptor, not an LLM tool call.
		const INTERNAL_EVENTS = new Set(["llm.response", "context.assemble"]);
		const toolNames = toolSpans
			.map((ts) => ts.name.replace("alef.command/", ""))
			.filter((n) => !INTERNAL_EVENTS.has(n));

		const retryReasonsRaw = s.attributes["alef.retry_reasons"];
		const retryReasons =
			typeof retryReasonsRaw === "string" && retryReasonsRaw.length > 0 ? retryReasonsRaw.split("|") : [];

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
			schemaTokensEstimate: Number(s.attributes["alef.schema_token_estimate"] ?? 0),
			retries: Number(s.attributes["alef.retry_count"] ?? 0),
			retryReasons,
			aborted: s.attributes["alef.aborted"] === true,
			llmTurn: Number(s.attributes["alef.turn_number"] ?? turnIndex),
		});
	}

	return turns;
}

/**
 *
 */
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
	 * Mirrors Tako TurnRecord.
	 */
	turns: TurnRecord[];
	/**
	 * Full conversation transcript: the complete messages array at end of the eval run.
	 * Each entry is { role, content, toolCallId?, toolName?, isError? }.
	 * Populated from the conversationHistory field on the last command llm.response event.
	 *
	 * Anthropic: "A transcript is the complete record of a trial, including outputs,
	 * tool calls, reasoning, and intermediate results."
	 */
	transcript: Array<Record<string, unknown>>;
	/** true if the agent produced the expected output without errors. */
	passed: boolean;
	/** Error message if passed=false. */
	error?: string;
	/** Total command+event messages observed. */
	totalEvents: number;
	/** Total alef.command/* and alef.event/* spans. */
	totalSpans: number;
	/** Spans where alef.cache.hit=true. */
	cacheHits: number;
	/** Spans where alef.cache.hit=false (actual handle() calls). */
	cacheMisses: number;
	/** Optimal Action Efficiency: cacheHits / totalSpans (0–1). */
	oae: number;
	/** true if EvaluatorAdapter detected a tool call loop. */
	loopDetected: boolean;
	/** Event type that looped, if any. */
	loopEventType?: string;
	/** All collected spans. */
	spans: SpanRecord[];
	/** Wall-clock duration of the full run. */
	durationMs: number;
	/**
	 * Average fraction of input tokens attributable to tool schema definitions.
	 * 0–1. NaN when no turns have tokensIn > 0.
	 * Decision gate for ToolShell: build if > 0.25.
	 */
	avgSchemaFraction: number;
	/**
	 * Wall-clock time for each ctx.send() call in ms.
	 * One entry per prompt. Partial when scenario times out mid-send.
	 * Trailing entry marked with * in formatReport when scenario timed out.
	 */
	sendTimingsMs: number[];
	/** True when the scenario was killed by the timeout ceiling. */
	timedOut: boolean;
	/**
	 * Real-time bus event capture: every command and event message observed during the run,
	 * in chronological order, with truncated payloads. Populated by harness.ts via
	 * agent.observe(). Skips llm.response (large) and context.assemble (internal).
	 *
	 * Unlike OTel spans, this includes in-flight command events that never received an
	 * event response — exactly what's needed to diagnose timeout scenarios.
	 */
	busEvents: BusEvent[];
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
	{ match: "alef.command/fs.read", points: 10 },
	{ match: "alef.command/fs.grep", points: 5 },
	{ match: "alef.command/fs.find", points: 3 },
	{ match: "alef.command/fs.write", points: -15 },
	{ match: "alef.command/fs.edit", points: -15 },
	{ match: "alef.command/shell.exec", points: -5 },
];

/** Standard Write scoring rules — writes are expected and rewarded. */
export const WRITE_RULES: ScoringRule[] = [
	{ match: "alef.command/fs.read", points: 5 },
	{ match: "alef.command/fs.grep", points: 3 },
	{ match: "alef.command/fs.write", points: 15 },
	{ match: "alef.command/fs.edit", points: 10 },
];

/**
 *
 */
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
