/**
 * EvalHarness — boots an Agent for evaluation runs.
 *
 * Design decisions:
 *   - Workspace: plain mkdtemp + cleanup. No EnclosureOrgan needed —
 *     eval workspaces are throwaway, not production codebases.
 *   - OTel: InMemorySpanExporter collects all alef.spine spans.
 *     No SDK required in the caller — harness sets it up.
 *   - Output: structured JSON + human summary. Pi-parsable.
 *   - Model: configured via options or ALEF_EVAL_MODEL env var.
 *     Default: anthropic/claude-sonnet-4-5.
 *   - Skip: if no API key detected, scenario is skipped (not failed).
 */

import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import type { ExecutionStrategy, Organ } from "@dpopsuev/alef-spine";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { EvaluatorOrgan } from "./evaluator-organ.js";
import type { BusEvent, RunMetrics, SpanRecord } from "./metrics.js";
import { deriveturns } from "./metrics.js";
import { globalSpanExporter } from "./otel-setup.js";
import { TraceRecorder } from "./trace-recorder.js";

const tracer = trace.getTracer("alef.eval", "0.0.1");

// ---------------------------------------------------------------------------
// Bus payload capture helpers
// ---------------------------------------------------------------------------

const BUS_PAYLOAD_MAX_CHARS = 400;

/**
 * Truncate a bus event payload for diagnostic capture.
 * Preserves structure; truncates long string values individually.
 */
function truncateBusPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!payload) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		// Skip internal metadata that adds noise without diagnostic value.
		if (k === "toolCallId" || k === "conversationHistory" || k === "isFinal") continue;
		if (typeof v === "string" && v.length > BUS_PAYLOAD_MAX_CHARS) {
			out[k] = `${v.slice(0, BUS_PAYLOAD_MAX_CHARS)}…`;
		} else {
			out[k] = v;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export interface WorkspaceFile {
	path: string;
	content: string;
}

export interface ScenarioContext extends ExecutionStrategy {
	/** Absolute path to the temp workspace directory. */
	workspace: string;
	/** Send a message to the agent and await the reply. */
	send(text: string, sender?: string, timeoutMs?: number): Promise<string>;
	/** Write a file into the workspace before or during the run. */
	writeFile(relativePath: string, content: string): Promise<void>;
	/** Read a file from the workspace. */
	readFile(relativePath: string): Promise<string>;
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<void>;

export interface HarnessOptions {
	/** Scenario identifier — appears in RunMetrics and the report. */
	scenario: string;
	/** Extra organs to load beyond dialog, fs, shell. */
	extraOrgans?: Organ[];
	/** System prompt for the agent. */
	systemPrompt?: string;
	/** Loop detection threshold. Default: 10. */
	loopThreshold?: number;
	/** Initial workspace files to write before the scenario runs. */
	seed?: WorkspaceFile[];
	/**
	 * Per-scenario wall-clock timeout in ms. Default: 180_000 (3 min).
	 * The harness aborts and marks the run failed if this is exceeded.
	 */
	scenarioTimeoutMs?: number;
	/**
	 * Whether to seed the workspace with realistic noise files.
	 * Default: true. Mitigates eval-awareness sandbagging (AISI finding):
	 * agents can detect eval context from sparse workspace structure.
	 */
	noiseSeeding?: boolean;
	/**
	 * When true, skip workspace cleanup after the run.
	 * The caller is responsible for calling rm(metrics.workspace).
	 * Used by EvaluationRunner so checkers can read files after agent completes.
	 */
	keepWorkspace?: boolean;
	/**
	 * Factory for abort-aware extra organs. Called inside run() with the Agent's
	 * AbortSignal so organs (e.g. Cerebrum) can cancel in-flight HTTP requests
	 * when the agent disposes. Prefer this over extraOrgans when the organ
	 * needs an AbortSignal.
	 *
	 * @example
	 * organFactory: (signal) => [new Cerebrum({ model, getSignal: () => signal })]
	 */
	organFactory?: (signal: AbortSignal) => Organ[];
	/**
	 * Override the tool list passed to Cerebrum.
	 * Default: () => agent.tools. Pass via organFactory to Cerebrum.getTools instead.
	 * @deprecated Pass getTools directly in the organFactory Cerebrum options.
	 */
	getTools?: () => readonly { name: string; description: string; inputSchema: unknown }[];
	/**
	 * Directory to write a JSONL execution trace file.
	 * File is named `{scenario}.trace.jsonl` in this directory.
	 * When unset, no trace file is written.
	 * Mirrors Tako engine/trace.TraceRecorder.
	 */
	traceDir?: string;
}

export class EvalHarness {
	/**
	 * Collect spans belonging to a specific trace (by traceId).
	 * Concurrent eval runs each have a unique traceId from their rootSpan
	 * (via AsyncLocalStorageContextManager), so filtering is safe without
	 * a global reset. Replaces the old collectAndResetSpans() pattern.
	 */
	private collectSpansByTrace(traceId: string): SpanRecord[] {
		const spans = globalSpanExporter
			.getFinishedSpans()
			.filter((s) => s.spanContext().traceId === traceId)
			.map((s) => {
				const attrs = Object.fromEntries(Object.entries(s.attributes ?? {}));
				// Extract args and result from span events if present (Anthropic pattern:
				// outcome = env state, not just transcript text).
				let args: Record<string, unknown> | undefined;
				let result: string | undefined;
				const retryReasons: string[] = [];
				for (const event of s.events ?? []) {
					if (event.name === "tool.args" && event.attributes) {
						const raw = event.attributes.args;
						if (typeof raw === "string") {
							try {
								args = JSON.parse(raw) as Record<string, unknown>;
							} catch {
								/* ignore */
							}
						}
					}
					if (event.name === "tool.result" && event.attributes) {
						const raw = event.attributes.result;
						if (typeof raw === "string") result = raw;
					}
					// ALE-BUG-39: collect retry reasons from llm.retry span events.
					if (event.name === "llm.retry" && event.attributes) {
						const reason = event.attributes.reason;
						if (typeof reason === "string") retryReasons.push(reason);
					}
				}
				// Merge retry reasons into attributes so deriveturns() can read them.
				if (retryReasons.length > 0) attrs["alef.retry_reasons"] = retryReasons.join("|");
				return {
					name: s.name,
					attributes: attrs,
					status: (s.status.code === 1 ? "ERROR" : s.status.code === 2 ? "OK" : "UNSET") as
						| "ERROR"
						| "OK"
						| "UNSET",
					durationMs: (s.duration[0] * 1e9 + s.duration[1]) / 1e6,
					...(args !== undefined && { args }),
					...(result !== undefined && { result }),
				};
			});
		return spans;
	}

	async run(scenarioFn: ScenarioFn, opts: HarnessOptions): Promise<RunMetrics> {
		const start = Date.now();
		const scenarioTimeoutMs = opts.scenarioTimeoutMs ?? 180_000;

		// Parent span: all tool + LLM spans during this run become children.
		// Enables Jaeger/Honeycomb to show one eval as a trace tree.
		// Mirrors Tako observe.OTelObserver.StartFab().
		const rootSpan = tracer.startSpan("eval.run", {
			kind: SpanKind.INTERNAL,
			attributes: { "alef.eval.scenario": opts.scenario },
		});
		const rootCtx = trace.setSpan(context.active(), rootSpan);

		// Neutral workspace name — no 'eval' prefix to avoid eval-awareness sandbagging.
		// AISI finding: agents detect eval context from workspace path signals.
		const workspace = join(tmpdir(), randomUUID());
		await mkdir(workspace, { recursive: true });

		// Realistic noise files — a completely empty workspace is itself a signal.
		if (opts.noiseSeeding !== false) {
			await writeFile(join(workspace, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
			await writeFile(join(workspace, "README.md"), "# Project\n\nA TypeScript project.\n", "utf-8");
		}

		// Seed workspace files.
		if (opts.seed) {
			for (const f of opts.seed) {
				const abs = join(workspace, f.path);
				await mkdir(join(abs, ".."), { recursive: true });
				await writeFile(abs, f.content, "utf-8");
			}
		}

		const evaluator = new EvaluatorOrgan({ loopThreshold: opts.loopThreshold });

		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {} });

		agent
			.load(dialog)
			.load(createFsOrgan({ cwd: workspace }))
			.load(createShellOrgan({ cwd: workspace }))
			.load(evaluator);

		for (const organ of opts.extraOrgans ?? []) {
			agent.load(organ);
		}
		for (const organ of opts.organFactory?.(agent.signal) ?? []) {
			agent.load(organ);
		}

		// Capture the conversation transcript from the last Motor dialog.message event.
		// conversationHistory is published by organ-llm as plain JSON: [{role, content, ...}].
		// Anthropic: "transcript = complete record of a trial, including tool calls".
		let transcript: Array<Record<string, unknown>> = [];
		const busEvents: BusEvent[] = [];
		// Motor start times keyed by correlationId for round-trip elapsed computation.
		const motorTimes = new Map<string, number>();
		// Events whose payloads are too large to capture verbatim.
		const SKIP_BUS_EVENTS = new Set(["dialog.message", "llm.phase"]);

		const transcriptObserver = agent.observe({
			onMotorEvent(event) {
				const p = event as unknown as {
					type?: string;
					correlationId?: string;
					payload?: Record<string, unknown>;
				};
				if (p.type === "dialog.message" && Array.isArray(p.payload?.conversationHistory)) {
					transcript = p.payload.conversationHistory as Array<Record<string, unknown>>;
				}
				if (!SKIP_BUS_EVENTS.has(p.type ?? "")) {
					motorTimes.set(p.correlationId ?? "", Date.now());
					busEvents.push({
						bus: "motor",
						event: p.type ?? "unknown",
						correlationId: p.correlationId ?? "",
						payload: truncateBusPayload(p.payload),
					});
				}
			},
			onSenseEvent(event) {
				const p = event as unknown as {
					type?: string;
					correlationId?: string;
					payload?: Record<string, unknown>;
					isError?: boolean;
					errorMessage?: string;
				};
				if (!SKIP_BUS_EVENTS.has(p.type ?? "")) {
					const startMs = motorTimes.get(p.correlationId ?? "");
					const elapsedMs = startMs !== undefined ? Date.now() - startMs : undefined;
					motorTimes.delete(p.correlationId ?? "");
					busEvents.push({
						bus: "sense",
						event: p.type ?? "unknown",
						correlationId: p.correlationId ?? "",
						payload: truncateBusPayload(p.payload),
						...(p.isError && { isError: true }),
						...(p.errorMessage && { errorMessage: p.errorMessage }),
						...(elapsedMs !== undefined && { elapsedMs }),
					});
				}
			},
		});

		// Optional JSONL trace — attach before the run, close after.
		let busTracer: TraceRecorder | undefined;
		let unobserve: (() => void) | undefined;
		if (opts.traceDir) {
			const safeName = opts.scenario.replace(/[^a-z0-9_-]/gi, "_");
			const tracePath = join(opts.traceDir, `${safeName}.trace.jsonl`);
			busTracer = new TraceRecorder(tracePath);
			busTracer.signal("session_start", { scenario: opts.scenario, workspace });
			unobserve = agent.observe(busTracer);
		}

		let passed = false;
		let error: string | undefined;
		let timedOut = false;
		const sendTimingsMs: number[] = [];
		let sendStart = 0;

		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => {
				timedOut = true;
				// Record partial timing for the in-flight send (ALE-BUG-38 / ALE-BUG-41).
				if (sendStart > 0) sendTimingsMs.push(Date.now() - sendStart);
				reject(new Error(`scenario timeout after ${scenarioTimeoutMs}ms`));
			}, scenarioTimeoutMs),
		);

		try {
			const ctx: ScenarioContext = {
				workspace,
				send: async (text) => {
					sendStart = Date.now();
					const reply = await dialog.send(text, "human", scenarioTimeoutMs);
					sendTimingsMs.push(Date.now() - sendStart);
					sendStart = 0;
					return reply;
				},
				writeFile: async (rel, content) => {
					const abs = join(workspace, rel);
					await mkdir(dirname(abs), { recursive: true });
					await writeFile(abs, content, "utf-8");
				},
				readFile: async (rel) => fsReadFile(join(workspace, rel), "utf-8"),
			};
			// Run the scenario under the root OTel context so child spans attach.
			await context.with(rootCtx, () => Promise.race([scenarioFn(ctx), timeoutPromise]));
			passed = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			transcriptObserver();
			if (busTracer) {
				busTracer.signal("session_end", { passed, error });
				unobserve?.();
				await busTracer.close();
			}
			agent.dispose();
			if (!opts.keepWorkspace) {
				await rm(workspace, { recursive: true, force: true });
			}
			rootSpan.setStatus(passed ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: error });
			rootSpan.end();
		}

		const spans = this.collectSpansByTrace(rootSpan.spanContext().traceId);
		const cacheHits = spans.filter((s) => s.attributes["alef.cache.hit"] === true).length;
		const cacheMisses = spans.filter((s) => s.attributes["alef.cache.hit"] === false).length;
		const totalSpans = spans.length;
		const oae = totalSpans > 0 ? cacheHits / totalSpans : 0;

		const turns = deriveturns(spans);
		const schemaFractions = turns.filter((t) => t.tokensIn > 0).map((t) => t.schemaTokensEstimate / t.tokensIn);
		const avgSchemaFraction =
			schemaFractions.length > 0 ? schemaFractions.reduce((a, b) => a + b, 0) / schemaFractions.length : Number.NaN;

		const metrics: RunMetrics = {
			scenario: opts.scenario,
			workspace: opts.keepWorkspace ? workspace : undefined,
			turns,
			transcript,
			busEvents,
			passed: passed && !evaluator.state.loopDetected,
			sendTimingsMs,
			timedOut,
			error: evaluator.state.loopDetected
				? `Loop detected: ${evaluator.state.loopEventType} called >${opts.loopThreshold ?? 10} times`
				: error,
			totalEvents: evaluator.state.motorCount + evaluator.state.senseCount,
			totalSpans,
			cacheHits,
			cacheMisses,
			oae,
			loopDetected: evaluator.state.loopDetected,
			loopEventType: evaluator.state.loopEventType,
			spans,
			durationMs: Date.now() - start,
			avgSchemaFraction,
		};

		return metrics;
	}
}

// ---------------------------------------------------------------------------
// MustUse assertions — span-based proof of tool invocation
// ---------------------------------------------------------------------------

/**
 * Assert that a specific motor event type was dispatched during a run.
 * Throws with a descriptive message listing what WAS called if the expected
 * tool is absent — fail-fast, no boolean returns.
 *
 * @param metrics  RunMetrics from harness.run()
 * @param eventType  Motor event type, e.g. "fs.read" or "shell.exec"
 */
export function assertToolUsed(metrics: RunMetrics, eventType: string): void {
	const spanName = `alef.motor/${eventType}`;
	const used = metrics.spans.some((s) => s.name === spanName);
	if (!used) {
		const usedTools = metrics.spans
			.filter((s) => s.name.startsWith("alef.motor/"))
			.map((s) => s.name.replace("alef.motor/", ""))
			.filter((name, i, arr) => arr.indexOf(name) === i);
		throw new Error(`Expected tool '${eventType}' to be called, but only these were used: [${usedTools.join(", ")}]`);
	}
}

/**
 * Assert that a specific motor event type was NOT dispatched during a run.
 * Throws if the tool WAS called (e.g. write tool in a read-only scenario).
 */
export function assertToolNotUsed(metrics: RunMetrics, eventType: string): void {
	const spanName = `alef.motor/${eventType}`;
	const used = metrics.spans.some((s) => s.name === spanName);
	if (used) {
		throw new Error(`Expected tool '${eventType}' NOT to be called, but it was.`);
	}
}

/**
 * Assert that all listed event types were dispatched.
 * Fails on the first missing tool with a full diagnostic.
 */
export function assertAllToolsUsed(metrics: RunMetrics, eventTypes: string[]): void {
	for (const et of eventTypes) {
		assertToolUsed(metrics, et);
	}
}

/**
 * Format RunMetrics as a human-readable summary.
 * Includes Anthropic-recommended tracked_metrics: n_turns, n_toolcalls, n_total_tokens.
 */
export function formatReport(metrics: RunMetrics): string {
	const status = metrics.passed ? "PASS" : "FAIL";
	const nTurns = metrics.turns.length;
	const nToolcalls = metrics.turns.reduce((a, t) => a + t.toolCalls, 0);
	const nTotalTokens = metrics.turns.reduce((a, t) => a + t.tokensIn + t.tokensOut, 0);
	const toolPath = metrics.turns.flatMap((t) => t.toolNames).join(" → ") || "(none)";

	// Send timings: mark last entry with * when scenario timed out (in-flight).
	const sendStr = metrics.sendTimingsMs
		.map((ms, i) => {
			const isLast = i === metrics.sendTimingsMs.length - 1;
			const label = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
			return isLast && metrics.timedOut ? `${label}*` : label;
		})
		.join(", ");

	// Retry summary across all turns.
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

	// On failure: emit the bus event trace so the tool call sequence + payloads
	// are visible without needing a separate debug run.
	if (!metrics.passed && metrics.busEvents.length > 0) {
		lines.push("  bus trace:");
		for (const e of metrics.busEvents) {
			const arrow = e.bus === "motor" ? "→" : "←";
			const elapsed = e.elapsedMs !== undefined ? ` ${e.elapsedMs}ms` : "";
			const err = e.isError ? ` ERROR: ${e.errorMessage ?? ""}` : "";
			const payloadStr = e.payload ? ` ${JSON.stringify(e.payload)}` : "";
			lines.push(`    ${arrow} ${e.bus}/${e.event}${elapsed}${err}${payloadStr}`);
		}
		// Surface any in-flight motor events with no matching sense response.
		// These are the calls that were pending when the timeout fired.
		const motorIds = new Set(metrics.busEvents.filter((e) => e.bus === "motor").map((e) => e.correlationId));
		const senseIds = new Set(metrics.busEvents.filter((e) => e.bus === "sense").map((e) => e.correlationId));
		const orphaned = [...motorIds].filter((id) => !senseIds.has(id));
		if (orphaned.length > 0) {
			const orphanedEvents = metrics.busEvents.filter(
				(e) => e.bus === "motor" && orphaned.includes(e.correlationId),
			);
			for (const e of orphanedEvents) {
				lines.push(`    ✗ no sense response for motor/${e.event} (correlationId=${e.correlationId.slice(0, 8)}…)`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Format the full conversation transcript for manual review.
 * Anthropic: "Once you have pass-or-fail tests, it's useful to also grade the transcript."
 */
export function formatTranscript(metrics: RunMetrics): string {
	if (metrics.transcript.length === 0) return `[${metrics.scenario}] no transcript captured`;

	const lines: string[] = [`=== TRANSCRIPT: ${metrics.scenario} ===`];
	for (const msg of metrics.transcript) {
		const role = String(msg.role ?? "?").toUpperCase();
		if (role === "TOOLRESULT") {
			const content =
				typeof msg.content === "string" ? msg.content.slice(0, 300) : JSON.stringify(msg.content).slice(0, 300);
			const truncated = content.length === 300 ? "..." : "";
			lines.push(`\n[TOOL RESULT: ${msg.toolName ?? "?"}]`);
			lines.push(content + truncated);
		} else if (role === "ASSISTANT") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
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

/**
 * Serialize metrics to JSON for Pi-parsable output.
 */
export function serializeReport(metrics: RunMetrics): string {
	return JSON.stringify(metrics, null, 2);
}
