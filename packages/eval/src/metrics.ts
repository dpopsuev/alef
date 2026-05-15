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
}

export interface RunMetrics {
	/** Scenario identifier. */
	scenario: string;
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
