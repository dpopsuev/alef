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
import type { Organ } from "@dpopsuev/alef-spine";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { EvaluatorOrgan } from "./evaluator-organ.js";
import type { RunMetrics, SpanRecord } from "./metrics.js";
import { deriveturns } from "./metrics.js";
import { globalSpanExporter } from "./otel-setup.js";
import { TraceRecorder } from "./trace-recorder.js";

const tracer = trace.getTracer("alef.eval", "0.0.1");

export interface WorkspaceFile {
	path: string;
	content: string;
}

export interface ScenarioContext {
	/** Absolute path to the temp workspace directory. */
	workspace: string;
	/** Send a message to the agent and await the reply. */
	send(text: string): Promise<string>;
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
	 * Directory to write a JSONL execution trace file.
	 * File is named `{scenario}.trace.jsonl` in this directory.
	 * When unset, no trace file is written.
	 * Mirrors Tako engine/trace.TraceRecorder.
	 */
	traceDir?: string;
}

export class EvalHarness {
	private collectAndResetSpans(): SpanRecord[] {
		const spans = globalSpanExporter.getFinishedSpans().map((s) => {
			const attrs = Object.fromEntries(Object.entries(s.attributes ?? {}));
			// Extract args and result from span events if present (Anthropic pattern:
			// outcome = env state, not just transcript text).
			let args: Record<string, unknown> | undefined;
			let result: string | undefined;
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
			}
			return {
				name: s.name,
				attributes: attrs,
				status: (s.status.code === 1 ? "ERROR" : s.status.code === 2 ? "OK" : "UNSET") as "ERROR" | "OK" | "UNSET",
				durationMs: (s.duration[0] * 1e9 + s.duration[1]) / 1e6,
				...(args !== undefined && { args }),
				...(result !== undefined && { result }),
			};
		});
		globalSpanExporter.reset();
		return spans;
	}

	async run(scenarioFn: ScenarioFn, opts: HarnessOptions): Promise<RunMetrics> {
		const start = Date.now();
		const scenarioTimeoutMs = opts.scenarioTimeoutMs ?? 180_000;
		// Reset exporter at start of each run — shared global exporter.
		globalSpanExporter.reset();

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
		const dialog = new DialogOrgan({
			sink: () => {},
			getTools: () => agent.tools,
			systemPrompt: opts.systemPrompt,
		});

		agent
			.load(dialog)
			.load(createFsOrgan({ cwd: workspace }))
			.load(createShellOrgan({ cwd: workspace }))
			.load(evaluator);

		for (const organ of opts.extraOrgans ?? []) {
			agent.load(organ);
		}

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

		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`scenario timeout after ${scenarioTimeoutMs}ms`)), scenarioTimeoutMs),
		);

		try {
			const ctx: ScenarioContext = {
				workspace,
				send: (text) => dialog.send(text, "human", 120_000),
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

		const spans = this.collectAndResetSpans();
		const cacheHits = spans.filter((s) => s.attributes["alef.cache.hit"] === true).length;
		const cacheMisses = spans.filter((s) => s.attributes["alef.cache.hit"] === false).length;
		const totalSpans = spans.length;
		const oae = totalSpans > 0 ? cacheHits / totalSpans : 0;

		const metrics: RunMetrics = {
			scenario: opts.scenario,
			workspace: opts.keepWorkspace ? workspace : undefined,
			turns: deriveturns(spans),
			passed: passed && !evaluator.state.loopDetected,
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
 */
export function formatReport(metrics: RunMetrics): string {
	const status = metrics.passed ? "PASS" : "FAIL";
	const lines = [
		`[${status}] ${metrics.scenario} (${metrics.durationMs}ms)`,
		`  spans: ${metrics.totalSpans}  cache hits: ${metrics.cacheHits}  misses: ${metrics.cacheMisses}  OAE: ${(metrics.oae * 100).toFixed(1)}%`,
		`  events: ${metrics.totalEvents}  loop: ${metrics.loopDetected ? `YES (${metrics.loopEventType})` : "no"}`,
	];
	if (metrics.error) lines.push(`  error: ${metrics.error}`);
	return lines.join("\n");
}

/**
 * Serialize metrics to JSON for Pi-parsable output.
 */
export function serializeReport(metrics: RunMetrics): string {
	return JSON.stringify(metrics, null, 2);
}
