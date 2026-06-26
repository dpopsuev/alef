/**
 * Report formatting — human-readable summaries of RunMetrics.
 *
 * Separated from harness.ts so EvalHarness stays focused on agent lifecycle.
 */

import type { RunMetrics } from "./metrics.js";

export function formatReport(metrics: RunMetrics): string {
	const status = metrics.passed ? "PASS" : "FAIL";
	const nTurns = metrics.turns.length;
	const nToolcalls = metrics.turns.reduce((a, t) => a + t.toolCalls, 0);
	const nTotalTokens = metrics.turns.reduce((a, t) => a + t.tokensIn + t.tokensOut, 0);
	const toolPath = metrics.turns.flatMap((t) => t.toolNames).join(" → ") || "(none)";

	const sendStr = metrics.sendTimingsMs
		.map((ms, i) => {
			const isLast = i === metrics.sendTimingsMs.length - 1;
			const label = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
			return isLast && metrics.timedOut ? `${label}*` : label;
		})
		.join(", ");

	const totalRetries = metrics.turns.reduce((a, t) => a + t.retries, 0);
	const retryReasons = [...new Set(metrics.turns.flatMap((t) => t.retryReasons))].join(", ");
	const abortedTurns = metrics.turns.filter((t) => t.aborted).length;

	const lines = [
		`[${status}] ${metrics.scenario} (${metrics.durationMs}ms)${metrics.timedOut ? " TIMEOUT" : ""}`,
		`  turns: ${nTurns}  tool_calls: ${nToolcalls}  tokens: ${nTotalTokens}  OAE: ${(metrics.oae * 100).toFixed(1)}%  schema_frac: ${Number.isNaN(metrics.avgSchemaFraction) ? "n/a" : `${(metrics.avgSchemaFraction * 100).toFixed(1)}%`}`,
		`  path: ${toolPath}`,
		`  transcript: ${metrics.transcript.length} messages  loop: ${metrics.loopDetected ? `YES (${metrics.loopEventType})` : "no"}`,
	];
	if (sendStr) lines.push(`  send timings: [${sendStr}]`);
	if (totalRetries > 0) lines.push(`  retries: ${totalRetries}${retryReasons ? ` (${retryReasons})` : ""}`);
	if (abortedTurns > 0) lines.push(`  aborted turns: ${abortedTurns}`);
	if (metrics.error) lines.push(`  error: ${metrics.error}`);

	if (!metrics.passed && metrics.busEvents.length > 0) {
		lines.push("  bus trace:");
		for (const e of metrics.busEvents) {
			const arrow = e.bus === "command" ? "→" : "←";
			const elapsed = e.elapsedMs !== undefined ? ` ${e.elapsedMs}ms` : "";
			const err = e.isError ? ` ERROR: ${e.errorMessage ?? ""}` : "";
			const payloadStr = e.payload ? ` ${JSON.stringify(e.payload)}` : "";
			lines.push(`    ${arrow} ${e.bus}/${e.event}${elapsed}${err}${payloadStr}`);
		}
		const motorIds = new Set(metrics.busEvents.filter((e) => e.bus === "command").map((e) => e.correlationId));
		const senseIds = new Set(metrics.busEvents.filter((e) => e.bus === "event").map((e) => e.correlationId));
		const orphaned = [...motorIds].filter((id) => !senseIds.has(id));
		if (orphaned.length > 0) {
			const orphanedEvents = metrics.busEvents.filter(
				(e) => e.bus === "command" && orphaned.includes(e.correlationId),
			);
			for (const e of orphanedEvents) {
				lines.push(
					`    ✗ no event response for command/${e.event} (correlationId=${e.correlationId.slice(0, 8)}…)`,
				);
			}
		}
	}

	return lines.join("\n");
}

export function formatTranscript(metrics: RunMetrics): string {
	if (metrics.transcript.length === 0) return `[${metrics.scenario}] no transcript captured`;

	const lines: string[] = [`=== TRANSCRIPT: ${metrics.scenario} ===`];
	for (const msg of metrics.transcript) {
		const role = String(msg.role ?? "?").toUpperCase();
		if (role === "TOOLRESULT") {
			const content =
				typeof msg.content === "string" ? msg.content.slice(0, 300) : JSON.stringify(msg.content).slice(0, 300);
			lines.push(`\n[TOOL RESULT: ${msg.toolName ?? "?"}]`);
			lines.push(content + (content.length === 300 ? "..." : ""));
		} else if (role === "ASSISTANT") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- transcript content blocks have known shape
					const b = block as Record<string, unknown>;
					if (b.type === "text") {
						lines.push(`\n[ASSISTANT]`);
						lines.push(String(b.text ?? "").slice(0, 500));
					} else if (b.type === "tool_use") {
						lines.push(`\n[TOOL CALL: ${b.name}]`);
						lines.push(JSON.stringify(b.input ?? {}, null, 2).slice(0, 400));
					}
				}
			} else {
				lines.push(`\n[ASSISTANT]`);
				lines.push(String(content ?? "").slice(0, 500));
			}
		} else {
			lines.push(`\n[${role}]`);
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			lines.push(content.slice(0, 500));
		}
	}
	lines.push(`\n=== END TRANSCRIPT (${metrics.transcript.length} messages) ===`);
	return lines.join("\n");
}

export function serializeReport(metrics: RunMetrics): string {
	return JSON.stringify(metrics, null, 2);
}
