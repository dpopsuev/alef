/**
 * JudgePanelRunner — runs specialist judge agents in parallel against a workspace.
 *
 * Each judge is a fresh Alef agent booted with:
 *   - Read-only tools: fs.read, fs.grep, shell.exec
 *   - JudgingAdapter: exposes report.submit
 *   - A SKILL.md seeded into .agents/skills/<name>/ so the agent discovers it
 *
 * Parallelism: AIMD scheduler (TCP congestion control) caps concurrency and
 * backs off on 429 rate-limit errors. Same pattern as the eval runPool.
 *
 * Independence: each judge has a separate agent session, separate conversation
 * history, and separate workspace view. No cross-contamination.
 *
 * The workspace is READ-ONLY for judges. The harness mounts the fs adapter
 * in read-only mode (no write actions). Judges can run shell commands that
 * read (git log, git diff, tsc --noEmit) but not commands that modify files.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFsAdapter } from "@dpopsuev/alef-tool-fs";
import { createShellAdapter } from "@dpopsuev/alef-tool-shell";
import { Agent, AgentController } from "@dpopsuev/alef-engine";

import type { JudgeReport } from "./judging-adapter.js";
import { createJudgingAdapter } from "./judging-adapter.js";

export interface JudgeSpec {
	name: string;
	/** SKILL.md content — the judge's persona and lens. */
	skillMd: string;
	/** Weight in the panel score aggregation. All weights should sum to 1.0. */
	weight: number;
	/** Opening prompt sent to the judge agent. */
	prompt: string;
}

export interface JudgeResult {
	name: string;
	weight: number;
	report?: JudgeReport;
	weightedScore: number;
	error?: string;
	durationMs: number;
}

export interface JudgePanelResult {
	judges: JudgeResult[];
	/** Weighted average of judge scores. */
	panelScore: number;
	/** All critical findings across all judges. */
	blockingFindings: Array<{ judge: string; location?: string; message: string }>;
}

// ---------------------------------------------------------------------------
// AIMD scheduler — mirrors the evaluations.test.ts pattern
// ---------------------------------------------------------------------------

class AimdScheduler {
	private concurrency: number;
	private readonly max: number;
	private streak = 0;
	private readonly threshold: number;

	constructor(initial: number, max: number, threshold = 3) {
		this.concurrency = Math.max(1, initial);
		this.max = max;
		this.threshold = threshold;
	}

	get current(): number {
		return this.concurrency;
	}

	onRetry(): void {
		this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
		this.streak = 0;
	}

	onSuccess(): void {
		if (++this.streak >= this.threshold && this.concurrency < this.max) {
			this.concurrency++;
			this.streak = 0;
		}
	}
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface JudgePanelRunnerOptions {
	/** Options forwarded to the agent loop factory. Must include asyncAdapterFactory. */
	agentLoopFactory: (
		workspace: string,
		signal: AbortSignal,
		extraAdapters: import("@dpopsuev/alef-kernel/adapter").Adapter[],
	) => Promise<import("@dpopsuev/alef-kernel/adapter").Adapter[]>;
	agentFactory?: (workspace: string, signal: AbortSignal) => Promise<import("@dpopsuev/alef-engine").Agent>;
	/** Turn timeout per judge agent in ms. Default: 120_000. */
	judgeTimeoutMs?: number;
	/** Max concurrent judge agents. Default: 3. */
	maxConcurrency?: number;
}

export class JudgePanelRunner {
	private readonly opts: JudgePanelRunnerOptions;

	constructor(opts: JudgePanelRunnerOptions) {
		this.opts = opts;
	}

	async run(judges: JudgeSpec[], workspace: string): Promise<JudgePanelResult> {
		const timeoutMs = this.opts.judgeTimeoutMs ?? 120_000;
		const maxConcurrency = this.opts.maxConcurrency ?? 3;
		const scheduler = new AimdScheduler(Math.min(3, maxConcurrency), maxConcurrency);

		const results: JudgeResult[] = new Array(judges.length).fill(null);
		const queue = judges.map((j, i) => ({ judge: j, index: i }));
		const inFlight: Promise<void>[] = [];

		const runOne = async (item: { judge: JudgeSpec; index: number }): Promise<void> => {
			const { judge } = item;
			const start = Date.now();

			try {
				const report = await this.runJudge(judge, workspace, timeoutMs);
				results[item.index] = {
					name: judge.name,
					weight: judge.weight,
					report,
					weightedScore: (report?.score ?? 0) * judge.weight,
					durationMs: Date.now() - start,
				};
				scheduler.onSuccess();
			} catch (e) {
				results[item.index] = {
					name: judge.name,
					weight: judge.weight,
					weightedScore: 0,
					error: e instanceof Error ? e.message : String(e),
					durationMs: Date.now() - start,
				};
				if (String(e).includes("429") || String(e).includes("rate")) scheduler.onRetry();
			}
		};

		let next = 0;
		const dispatch = (): void => {
			while (inFlight.length < scheduler.current && next < queue.length) {
				const item = queue[next++];
				const p = runOne(item).finally(() => {
					inFlight.splice(inFlight.indexOf(p), 1);
					dispatch();
				});
				inFlight.push(p);
			}
		};

		dispatch();
		while (inFlight.length > 0) await Promise.race(inFlight);

		const valid = results.filter((r) => !!r.report);
		const panelScore = valid.length > 0 ? valid.reduce((s, r) => s + r.weightedScore, 0) : 0;

		const blockingFindings = valid.flatMap((r) =>
			(r.report?.findings ?? [])
				.filter((f) => f.severity === "critical")
				.map((f) => ({ judge: r.name, location: f.location, message: f.message })),
		);

		return { judges: results, panelScore, blockingFindings };
	}

	private async runJudge(judge: JudgeSpec, workspace: string, timeoutMs: number): Promise<JudgeReport | undefined> {
		// Seed the skill into the workspace so the agent discovers it via standard paths.
		const skillDir = join(workspace, ".agents", "skills", judge.name);
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), judge.skillMd, "utf-8");

		let capturedReport: JudgeReport | undefined;
		const judgingAdapter = createJudgingAdapter({
			onReport: (r) => {
				capturedReport = r;
			},
		});

		const agent = this.opts.agentFactory ? await this.opts.agentFactory(workspace, new AbortController().signal) : new Agent();

		// Read-only fs adapter (no write actions).
		const fsReadOnly = createFsAdapter({
			cwd: workspace,
			actions: ["read", "grep", "find"],
		});
		const shell = createShellAdapter({ cwd: workspace });

		// Domain-specific adapters from the caller's factory.
		const extraAdapters = await this.opts.agentLoopFactory(workspace, agent.signal, [
			fsReadOnly,
			shell,
			judgingAdapter,
		]);

		for (const adapter of extraAdapters) agent.load(adapter);

		const controller = new AgentController(agent);
		await agent.ready();

		try {
			await Promise.race([
				controller.send(judge.prompt, "human", timeoutMs),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`judge ${judge.name} timed out`)), timeoutMs),
				),
			]);
		} finally {
			agent.dispose();
			// Clean up the seeded skill.
			await rm(skillDir, { recursive: true, force: true }).catch(() => {});
		}

		return capturedReport;
	}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatJudgePanelReport(result: JudgePanelResult): string {
	const lines = [
		`Judge Panel Score: ${result.panelScore.toFixed(3)}`,
		`${"─".repeat(60)}`,
		`${"Judge".padEnd(18)} ${"w".padStart(5)} ${"score".padStart(6)} ${"verdict".padStart(10)}  summary`,
		`${"─".repeat(60)}`,
	];

	for (const r of result.judges) {
		const score = r.report?.score.toFixed(2) ?? "err";
		const verdict = r.report?.verdict ?? (r.error ? "error" : "no-report");
		const summary = r.report?.summary ?? r.error ?? "";
		lines.push(
			`${r.name.padEnd(18)} ${r.weight.toFixed(2).padStart(5)} ${score.padStart(6)} ${verdict.padStart(10)}  ${summary.slice(0, 40)}`,
		);
		for (const f of r.report?.findings ?? []) {
			lines.push(`  [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}`);
		}
	}

	if (result.blockingFindings.length > 0) {
		lines.push(`${"─".repeat(60)}`);
		lines.push("Blocking findings:");
		for (const b of result.blockingFindings) {
			lines.push(`  [${b.judge}] ${b.location ? `${b.location}: ` : ""}${b.message}`);
		}
	}

	return lines.join("\n");
}
