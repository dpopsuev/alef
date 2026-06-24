import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";

const TOOL_CALL_JSON_PATTERNS = [
	/\{\s*"tool"\s*:\s*"/,
	/\{\s*"name"\s*:\s*"[a-z]+\.[a-z]+"/,
	/```json\s*\[?\s*\{[^}]*"tool"/,
	/await\s+[a-z]+\.(read|write|exec|search|find|run|fetch)\s*\(/,
];

export function toolCallsAreReal(expectedToolPrefix?: string): Checker {
	return {
		check({ lastReply, spans }: CheckerContext): CheckerResult {
			if (!lastReply) return { pass: true, score: 1.0, errors: [] };

			const hasJsonToolCalls = TOOL_CALL_JSON_PATTERNS.some((p) => p.test(lastReply));

			const toolSpans = spans.filter((s) => {
				const name = s.name ?? "";
				if (expectedToolPrefix) return name.startsWith(expectedToolPrefix);
				return name.includes(".") && !name.startsWith("llm.") && !name.startsWith("context.");
			});

			if (hasJsonToolCalls && toolSpans.length === 0) {
				return {
					pass: false,
					score: 0,
					errors: [
						"LLM output JSON text describing tool calls instead of making actual tool_use API calls. " +
							"This indicates the progressive disclosure pipeline sent empty schemas, " +
							"and the model fell back to text output.",
					],
				};
			}

			return { pass: true, score: 1.0, errors: [] };
		},
	};
}
