/**
 * EvalHarness — boots an Agent for evaluation runs.
 *
 * Two entry points:
 *
 *   boot(opts)  → AgentHandle          — incremental control (PhaseEvaluationRunner)
 *   run(fn, opts) → RunMetrics         — convenience wrapper for simple scenarios
 *
 * Design decisions:
 *   - Workspace: plain mkdtemp + cleanup. No EnclosureAdapter needed —
 *     eval workspaces are throwaway, not production codebases.
 *   - OTel: InMemorySpanExporter collects all alef.adapter / alef.eval spans.
 *     No SDK required in the caller — harness sets it up.
 *   - Model: configured via options or ALEF_EVAL_MODEL env var.
 *   - Skip: if no API key detected, scenario is skipped (not failed).
 */

import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { defaultEvalAdapters } from "./default-adapters.js";
import { EvaluatorAdapter } from "./evaluator-adapter.js";
import type { BusEvent, RunMetrics, SpanRecord } from "./metrics.js";
import { aggregateRunUsage, deriveturns } from "./metrics.js";
import { globalSpanExporter } from "./otel-setup.js";
import { TraceRecorder } from "./trace-recorder.js";

const tracer = trace.getTracer("alef.eval", "0.0.1");

// ---------------------------------------------------------------------------
// Bus payload capture
// ---------------------------------------------------------------------------

const BUS_PAYLOAD_MAX_CHARS = 400;

/** Truncate large bus payload values to keep eval traces readable. */
function truncateBusPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!payload) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (k === "toolCallId" || k === "conversationHistory" || k === "isFinal") continue;
		if (typeof v === "string" && v.length > BUS_PAYLOAD_MAX_CHARS) {
			out[k] = `${v.slice(0, BUS_PAYLOAD_MAX_CHARS)}…`;
		} else {
			out[k] = v;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A file to seed into the eval workspace before the agent runs. */
export interface WorkspaceFile {
	path: string;
	content: string;
}

/** Configuration for an EvalHarness run — workspace, adapters, timeouts. */
export interface HarnessOptions {
	/** Scenario identifier — appears in RunMetrics and the report. */
	scenario: string;
	/** Factory for the base adapter set. Default: fs + shell at workspace cwd. */
	baseAdaptersFactory?: (workspace: string) => Adapter[];
	/** Extra adapters beyond the base set. */
	extraAdapters?: Adapter[];
	/** System prompt for the agent. */
	systemPrompt?: string;
	/** Loop detection threshold. Default: 10. */
	loopThreshold?: number;
	/** Initial workspace files to write before the run. */
	seed?: WorkspaceFile[];
	/** Per-scenario wall-clock timeout in ms. Default: 180_000. */
	scenarioTimeoutMs?: number;
	/**
	 * Seed workspace with realistic noise files (.gitignore, README.md).
	 * Default: true. Mitigates eval-awareness sandbagging (AISI finding).
	 */
	noiseSeeding?: boolean;
	/**
	 * Skip workspace cleanup after the run.
	 * Used by EvaluationRunner so checkers can read files after the agent completes.
	 * Prefer AgentHandle (boot()) which owns cleanup explicitly.
	 */
	keepWorkspace?: boolean;
	/** Factory for abort-aware adapters (preferred over extraAdapters). */
	adapterFactory?: (signal: AbortSignal) => Adapter[];
	/** Async adapter factory — receives workspace path and signal. Takes precedence over adapterFactory. */
	asyncAdapterFactory?: (workspace: string, signal: AbortSignal) => Promise<Adapter[]>;
	/** Directory to write a JSONL execution trace file. */
	traceDir?: string;
	/**
	 * Factory for the Agent instance. When provided, the harness uses this
	 * instead of `new Agent()`. The caller is responsible for loading all
	 * adapters (including LLM, ToolShell, LoopGuard, etc.) onto the returned
	 * agent. The evaluator adapter is still loaded by the harness.
	 *
	 * Use this to match the production agent assembly exactly.
	 */
	agentFactory?: (workspace: string, signal: AbortSignal) => Promise<Agent>;
}

// ---------------------------------------------------------------------------
// AgentHandle — incremental control for PhaseEvaluationRunner
// ---------------------------------------------------------------------------

/** Handle to a running eval agent — send turns, collect spans, dispose. */
export class AgentHandle {
	readonly path: string;

	private readonly _agent: Agent;
	private readonly _controller: AgentController;
	private readonly _evaluator: EvaluatorAdapter;
	private readonly _rootSpan: ReturnType<typeof tracer.startSpan>;
	private readonly _rootCtx: ReturnType<typeof trace.setSpan>;
	private readonly _transcriptObserver: () => void;
	private readonly _busTracer?: TraceRecorder;
	private readonly _unobserve?: () => void;
	private readonly _keepWorkspace: boolean;
	private readonly _scenarioTimeoutMs: number;
	private readonly _transcript: Array<Record<string, unknown>> = [];
	private readonly _busEvents: BusEvent[] = [];

	private readonly _sendTimingsMs: number[] = [];

	private _lastReply = "";
	private _disposed = false;
	private _passed = false;
	private _error: string | undefined;
	private _timedOut = false;

	/** @internal — constructed by EvalHarness.boot() */
	constructor(params: {
		path: string;
		agent: Agent;
		controller: AgentController;
		evaluator: EvaluatorAdapter;
		rootSpan: ReturnType<typeof tracer.startSpan>;
		rootCtx: ReturnType<typeof trace.setSpan>;
		transcriptObserver: () => void;
		busTracer?: TraceRecorder;
		unobserve?: () => void;
		keepWorkspace: boolean;
		scenarioTimeoutMs: number;
		transcript: Array<Record<string, unknown>>;
		busEvents: BusEvent[];
		motorTimes: Map<string, number>;
	}) {
		this.path = params.path;
		this._agent = params.agent;
		this._controller = params.controller;
		this._evaluator = params.evaluator;
		this._rootSpan = params.rootSpan;
		this._rootCtx = params.rootCtx;
		this._transcriptObserver = params.transcriptObserver;
		this._busTracer = params.busTracer;
		this._unobserve = params.unobserve;
		this._keepWorkspace = params.keepWorkspace;
		this._scenarioTimeoutMs = params.scenarioTimeoutMs;
		this._transcript = params.transcript;
		this._busEvents = params.busEvents;
		void params.motorTimes; // captured by closure in boot(), not needed as a field
	}

	get lastReply(): string {
		return this._lastReply;
	}

	get loopDetected(): boolean {
		return this._evaluator.state.loopDetected;
	}

	/** Send one turn to the agent and await the reply. */
	async send(text: string): Promise<string> {
		const sendStart = Date.now();
		const reply = await context.with(this._rootCtx, () =>
			this._controller.send(text, "human", this._scenarioTimeoutMs),
		);
		this._sendTimingsMs.push(Date.now() - sendStart);
		this._lastReply = reply;
		return reply;
	}

	/** Write a file into the workspace. */
	async writeFile(relativePath: string, content: string): Promise<void> {
		const abs = join(this.path, relativePath);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf-8");
	}

	/** Read a file from the workspace. */
	async readFile(relativePath: string): Promise<string> {
		return fsReadFile(join(this.path, relativePath), "utf-8");
	}

	/** OTel spans collected so far for this run. */
	spans(): SpanRecord[] {
		return globalSpanExporter
			.getFinishedSpans()
			.filter((s) => s.spanContext().traceId === this._rootSpan.spanContext().traceId)
			.map((s) => {
				const attrs = Object.fromEntries(Object.entries(s.attributes));
				let args: Record<string, unknown> | undefined;
				let result: string | undefined;
				const retryReasons: string[] = [];
				for (const event of s.events) {
					if (event.name === "tool.args" && event.attributes) {
						const raw = event.attributes.args;
						if (typeof raw === "string") {
							try {
								// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown, casting to expected shape
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
					if (event.name === "llm.retry" && event.attributes) {
						const reason = event.attributes.reason;
						if (typeof reason === "string") retryReasons.push(reason);
					}
				}
				if (retryReasons.length > 0) attrs["alef.retry_reasons"] = retryReasons.join("|");
				const spanStatusMap: Partial<Record<number, "ERROR" | "OK">> = {
					[SpanStatusCode.ERROR]: "ERROR",
					[SpanStatusCode.OK]: "OK",
				};
				const spanStatus: "ERROR" | "OK" | "UNSET" = spanStatusMap[s.status.code] ?? "UNSET";
				return {
					name: s.name,
					attributes: attrs,
					status: spanStatus,
					// eslint-disable-next-line no-magic-numbers
					durationMs: (s.duration[0] * 1e9 + s.duration[1]) / 1e6,
					...(args !== undefined && { args }),
					...(result !== undefined && { result }),
				};
			});
	}

	/** Mark the run as passed and finalize. Returns RunMetrics. */
	async dispose(passed = true): Promise<RunMetrics> {
		if (this._disposed) throw new Error("AgentHandle already disposed");
		this._disposed = true;
		this._passed = passed;

		this._transcriptObserver();
		if (this._busTracer) {
			this._busTracer.signal("session_end", { passed: this._passed, error: this._error });
			this._unobserve?.();
			await this._busTracer.close();
		}
		void this._agent.dispose();

		if (!this._keepWorkspace) {
			await rm(this.path, { recursive: true, force: true });
		}

		this._rootSpan.setStatus(
			this._passed ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: this._error },
		);
		this._rootSpan.end();

		const spans = this.spans();
		const cacheHits = spans.filter((s) => s.attributes["alef.cache.hit"] === true).length;
		const cacheMisses = spans.filter((s) => s.attributes["alef.cache.hit"] === false).length;
		const totalSpans = spans.length;
		const oae = totalSpans > 0 ? cacheHits / totalSpans : 0;

		const turns = deriveturns(spans);
		const schemaFractions = turns.filter((t) => t.tokensIn > 0).map((t) => t.schemaTokensEstimate / t.tokensIn);
		const avgSchemaFraction =
			schemaFractions.length > 0 ? schemaFractions.reduce((a, b) => a + b, 0) / schemaFractions.length : Number.NaN;
		const usage = aggregateRunUsage(turns, this._busEvents);

		return {
			scenario: this._rootSpan.spanContext().traceId, // overwritten by callers
			workspace: this._keepWorkspace ? this.path : undefined,
			turns,
			transcript: this._transcript,
			busEvents: this._busEvents,
			passed: this._passed && !this._evaluator.state.loopDetected,
			sendTimingsMs: this._sendTimingsMs,
			timedOut: this._timedOut,
			error: this._evaluator.state.loopDetected
				? `Loop detected: ${this._evaluator.state.loopEventType}`
				: this._error,
			totalEvents: this._evaluator.state.commandCount + this._evaluator.state.eventCount,
			totalSpans,
			cacheHits,
			cacheMisses,
			oae,
			loopDetected: this._evaluator.state.loopDetected,
			loopEventType: this._evaluator.state.loopEventType,
			spans,
			durationMs: 0, // set by callers with real timing
			avgSchemaFraction,
			...usage,
		};
	}

	/** @internal — set by run() */
	_setError(error: string, timedOut = false): void {
		this._error = error;
		this._timedOut = timedOut;
	}
}

// ---------------------------------------------------------------------------
// EvalHarness
// ---------------------------------------------------------------------------

/** Boots an Agent for evaluation runs with OTel tracing and workspace management. */
export class EvalHarness {
	/**
	 * Boot an agent and return an AgentHandle for incremental control.
	 * The caller drives send() calls and must call dispose() when done.
	 */
	async boot(opts: HarnessOptions): Promise<AgentHandle> {
		// eslint-disable-next-line no-magic-numbers
		const scenarioTimeoutMs = opts.scenarioTimeoutMs ?? 180_000;

		const rootSpan = tracer.startSpan("eval.run", {
			kind: SpanKind.INTERNAL,
			attributes: { "alef.eval.scenario": opts.scenario },
		});
		const rootCtx = trace.setSpan(context.active(), rootSpan);

		// Neutral workspace name — no 'eval' prefix to avoid eval-awareness sandbagging.
		const workspace = join(tmpdir(), randomUUID());
		await mkdir(workspace, { recursive: true });

		if (opts.noiseSeeding !== false) {
			await writeFile(join(workspace, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
			await writeFile(join(workspace, "README.md"), "# Project\n\nA TypeScript project.\n", "utf-8");
		}

		if (opts.seed) {
			for (const f of opts.seed) {
				const abs = join(workspace, f.path);
				await mkdir(join(abs, ".."), { recursive: true });
				await writeFile(abs, f.content, "utf-8");
			}
		}

		const evaluator = new EvaluatorAdapter({ loopThreshold: opts.loopThreshold });

		let agent: Agent;
		if (opts.agentFactory) {
			agent = await opts.agentFactory(workspace, new AbortController().signal);
			agent.load(evaluator);
		} else {
			agent = new Agent();
			const baseAdapters = (opts.baseAdaptersFactory ?? defaultEvalAdapters)(workspace);
			for (const adapter of baseAdapters) agent.load(adapter);
			agent.load(evaluator);
			for (const adapter of opts.extraAdapters ?? []) agent.load(adapter);

			const asyncFactory = opts.asyncAdapterFactory;
			const syncFactory = opts.adapterFactory;
			const asyncAdapters = asyncFactory
				? await asyncFactory(workspace, agent.signal)
				: (syncFactory?.(agent.signal) ?? []);
			for (const adapter of asyncAdapters) agent.load(adapter);
		}

		const transcript: Array<Record<string, unknown>> = [];
		const busEvents: BusEvent[] = [];
		const motorTimes = new Map<string, number>();
		const SKIP_BUS_EVENTS = new Set(["llm.response", "context.assemble"]);

		const transcriptObserver = agent.observe({
			onCommand(event) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage is opaque, cast to known event shape
				const p = event as unknown as { type?: string; correlationId?: string; payload?: Record<string, unknown> };
				if (p.type === "llm.response" && Array.isArray(p.payload?.conversationHistory)) {
					transcript.splice(
						0,
						transcript.length,
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- conversationHistory is an array of message objects
						...(p.payload.conversationHistory as Array<Record<string, unknown>>),
					);
				}
				if (!SKIP_BUS_EVENTS.has(p.type ?? "")) {
					motorTimes.set(p.correlationId ?? "", Date.now());
					busEvents.push({
						bus: "command",
						event: p.type ?? "unknown",
						correlationId: p.correlationId ?? "",
						payload: truncateBusPayload(p.payload),
					});
				}
			},
			onEvent(event) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage is opaque, cast to known event shape
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
						bus: "event",
						event: p.type ?? "unknown",
						correlationId: p.correlationId ?? "",
						payload: truncateBusPayload(p.payload),
						...(p.isError && { isError: true }),
						...(p.errorMessage && { errorMessage: p.errorMessage }),
						...(elapsedMs !== undefined && { elapsedMs }),
					});
				}
			},
			onNotification(event) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage is opaque, cast to known event shape
				const p = event as unknown as { type?: string; correlationId?: string; payload?: Record<string, unknown> };
				busEvents.push({
					bus: "notification",
					event: p.type ?? "unknown",
					correlationId: p.correlationId ?? "",
					payload: truncateBusPayload(p.payload),
				});
			},
		});

		let busTracer: TraceRecorder | undefined;
		let unobserve: (() => void) | undefined;
		if (opts.traceDir) {
			const safeName = opts.scenario.replace(/[^a-z0-9_-]/gi, "_");
			busTracer = new TraceRecorder(join(opts.traceDir, `${safeName}.trace.jsonl`));
			busTracer.signal("session_start", { scenario: opts.scenario, workspace });
			unobserve = agent.observe(busTracer);
		}

		const controller = new AgentController(agent);

		return new AgentHandle({
			path: workspace,
			agent,
			controller,
			evaluator,
			rootSpan,
			rootCtx,
			transcriptObserver,
			busTracer,
			unobserve,
			keepWorkspace: opts.keepWorkspace ?? false,
			scenarioTimeoutMs,
			transcript,
			busEvents,
			motorTimes,
		});
	}

	/**
	 * Convenience wrapper — boots, runs a callback, disposes.
	 * Kept for existing tests and EvaluationRunner compatibility.
	 */
	async run(
		scenarioFn: (ctx: {
			workspace: string;
			send(args: { text: string }): Promise<string>;
			writeFile(rel: string, content: string): Promise<void>;
			readFile(rel: string): Promise<string>;
		}) => Promise<void>,
		opts: HarnessOptions,
	): Promise<RunMetrics> {
		const start = Date.now();
		const handle = await this.boot(opts);

		// eslint-disable-next-line no-magic-numbers
		const scenarioTimeoutMs = opts.scenarioTimeoutMs ?? 180_000;
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => {
				handle._setError(`scenario timeout after ${scenarioTimeoutMs}ms`, true);
				reject(new Error(`scenario timeout after ${scenarioTimeoutMs}ms`));
			}, scenarioTimeoutMs),
		);

		let passed = false;
		try {
			await Promise.race([
				scenarioFn({
					workspace: handle.path,
					send: ({ text }) => handle.send(text),
					writeFile: (rel, content) => handle.writeFile(rel, content),
					readFile: (rel) => handle.readFile(rel),
				}),
				timeoutPromise,
			]);
			passed = true;
		} catch (e) {
			handle._setError(e instanceof Error ? e.message : String(e));
		}

		const metrics = await handle.dispose(passed);
		// Patch scenario name and timing (handle uses traceId as placeholder)
		return { ...metrics, scenario: opts.scenario, durationMs: Date.now() - start };
	}
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Assert that a specific tool was used during the eval run. */
export function assertToolUsed(metrics: RunMetrics, eventType: string): void {
	const spanName = `alef.command/${eventType}`;
	const used = metrics.spans.some((s) => s.name === spanName);
	if (!used) {
		const usedTools = metrics.spans
			.filter((s) => s.name.startsWith("alef.command/"))
			.map((s) => s.name.replace("alef.command/", ""))
			.filter((name, i, arr) => arr.indexOf(name) === i);
		throw new Error(`Expected tool '${eventType}' to be called, but only these were used: [${usedTools.join(", ")}]`);
	}
}

/** Assert that a specific tool was NOT used during the eval run. */
export function assertToolNotUsed(metrics: RunMetrics, eventType: string): void {
	const spanName = `alef.command/${eventType}`;
	if (metrics.spans.some((s) => s.name === spanName)) {
		throw new Error(`Expected tool '${eventType}' NOT to be called, but it was.`);
	}
}

/** Assert that all specified tools were used during the eval run. */
export function assertAllToolsUsed(metrics: RunMetrics, eventTypes: string[]): void {
	for (const et of eventTypes) assertToolUsed(metrics, et);
}
