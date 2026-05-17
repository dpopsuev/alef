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

import { readFile as fsReadFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import type { Organ } from "@dpopsuev/alef-spine";
import { EvaluatorOrgan } from "./evaluator-organ.js";
import type { RunMetrics, SpanRecord } from "./metrics.js";
import { globalSpanExporter } from "./otel-setup.js";

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
}

export class EvalHarness {
	private collectAndResetSpans(): SpanRecord[] {
		const spans = globalSpanExporter.getFinishedSpans().map((s) => ({
			name: s.name,
			attributes: Object.fromEntries(Object.entries(s.attributes ?? {})),
			status: (s.status.code === 1 ? "ERROR" : s.status.code === 2 ? "OK" : "UNSET") as "ERROR" | "OK" | "UNSET",
			durationMs: (s.duration[0] * 1e9 + s.duration[1]) / 1e6,
		}));
		globalSpanExporter.reset();
		return spans;
	}

	async run(scenarioFn: ScenarioFn, opts: HarnessOptions): Promise<RunMetrics> {
		const start = Date.now();
		// Reset exporter at start of each run — shared global exporter.
		globalSpanExporter.reset();

		// Create temp workspace.
		const workspace = join(tmpdir(), `alef-eval-${opts.scenario}-${Date.now()}`);
		await mkdir(workspace, { recursive: true });

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

		let passed = false;
		let error: string | undefined;

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
			await scenarioFn(ctx);
			passed = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			agent.dispose();
			await rm(workspace, { recursive: true, force: true });
		}

		const spans = this.collectAndResetSpans();
		const cacheHits = spans.filter((s) => s.attributes["alef.cache.hit"] === true).length;
		const cacheMisses = spans.filter((s) => s.attributes["alef.cache.hit"] === false).length;
		const totalSpans = spans.length;
		const oae = totalSpans > 0 ? cacheHits / totalSpans : 0;

		const metrics: RunMetrics = {
			scenario: opts.scenario,
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
