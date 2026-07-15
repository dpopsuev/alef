/**
 * Shared OTel bootstrap for CLI and headless sessions.
 *
 * Env:
 *   ALEF_OTEL=1 — enable setup from createAgent / headless (CLI always enables)
 *   OTEL_EXPORTER_OTLP_ENDPOINT — when set, also export traces via OTLP/HTTP
 *   TRACEPARENT / TRACESTATE — W3C Trace Context inherited from parent process
 */

import {
	context,
	propagation,
	ROOT_CONTEXT,
	trace,
	type Context,
	type Span,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { InMemorySpanExporter, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const COST_FRACTION_DIGITS = 4;

let memoryExporter: InMemorySpanExporter | undefined;
let provider: NodeTracerProvider | undefined;
let sessionSpan: Span | undefined;
let propagatorReady = false;

/** Install W3C Trace Context as the global text-map propagator (once). */
function ensureW3cPropagator(): void {
	if (propagatorReady) return;
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	propagatorReady = true;
}

/** Normalize Collector base URL to the OTLP/HTTP traces path. */
function joinOtlpTracesUrl(endpoint: string): string {
	if (endpoint.includes("/v1/traces")) return endpoint;
	return `${endpoint.replace(/\/$/, "")}/v1/traces`;
}

/** Resolve active context, preferring TRACEPARENT from the parent process. */
function extractInheritedContext(): Context {
	ensureW3cPropagator();
	const carrier: Record<string, string> = {};
	const traceparent = process.env.TRACEPARENT?.trim();
	const tracestate = process.env.TRACESTATE?.trim();
	if (traceparent) carrier.traceparent = traceparent;
	if (tracestate) carrier.tracestate = tracestate;
	if (!carrier.traceparent) return context.active();
	return propagation.extract(ROOT_CONTEXT, carrier);
}

/** Build in-memory + optional SQLite + optional OTLP processors. */
async function buildProcessors(includeSqlite: boolean): Promise<SpanProcessor[]> {
	memoryExporter ??= new InMemorySpanExporter();
	const processors: SpanProcessor[] = [new SimpleSpanProcessor(memoryExporter)];

	if (includeSqlite) {
		try {
			const { getDatabase } = await import("@dpopsuev/alef-storage/sqlite/database");
			const { SqliteSpanExporter } = await import("@dpopsuev/alef-storage/sqlite/span-exporter");
			const db = await getDatabase();
			processors.push(new SimpleSpanProcessor(new SqliteSpanExporter(db)));
		} catch {
			// Database not available
		}
	}

	const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (otlpEndpoint) {
		try {
			const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
			processors.push(
				new SimpleSpanProcessor(new OTLPTraceExporter({ url: joinOtlpTracesUrl(otlpEndpoint) })),
			);
		} catch {
			// OTLP package missing or init failed — local exporters only
		}
	}

	return processors;
}

/** Register tracer provider + HTTP auto-instrumentation. Idempotent. */
export function setupOTel(): void {
	if (provider) return;
	ensureW3cPropagator();
	memoryExporter = new InMemorySpanExporter();
	provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
	});
	provider.register();

	registerInstrumentations({
		instrumentations: [
			getNodeAutoInstrumentations({
				"@opentelemetry/instrumentation-http": { enabled: true },
				"@opentelemetry/instrumentation-dns": { enabled: false },
				"@opentelemetry/instrumentation-fs": { enabled: false },
			}),
		],
	});

	activateInheritedTraceContext();
}

/**
 * Make the inherited W3C parent (TRACEPARENT) the active context and open
 * a long-lived alef.session span so child-process tool spans can link up.
 */
export function activateInheritedTraceContext(): Context {
	const inherited = extractInheritedContext();
	const tracer = trace.getTracer("alef.boot");
	const span = tracer.startSpan(
		"alef.session",
		{
			attributes: {
				...(process.env.ALEF_PARENT_SESSION_ID
					? { "alef.parent.session_id": process.env.ALEF_PARENT_SESSION_ID }
					: {}),
				...(process.env.TRACEPARENT ? { "alef.w3c.traceparent": process.env.TRACEPARENT } : {}),
			},
		},
		inherited,
	);
	sessionSpan = span;
	const ctx = trace.setSpan(inherited, span);
	enterContext(ctx);
	return ctx;
}

/** Best-effort process-wide ALS enter (Node context manager). */
function enterContext(ctx: Context): void {
	// ContextAPI hides enterWith; Node's AsyncLocalStorage manager exposes it.
	const api = context as unknown;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OTel ContextAPI has no public enterWith
	const manager = (api as { _getContextManager?: () => { enterWith?: (c: Context) => void } })._getContextManager?.();
	manager?.enterWith?.(ctx);
}

/** Run `fn` under the inherited / session trace context. */
export function runWithInheritedTrace<T>(fn: () => T): T {
	const ctx = sessionSpan ? trace.setSpan(extractInheritedContext(), sessionSpan) : extractInheritedContext();
	return context.with(ctx, fn);
}

/** Inject W3C Trace Context (+ optional parent session) into a child env. */
export function injectTraceContextIntoEnv(
	env: NodeJS.ProcessEnv,
	parentSessionId?: string,
	ctx: Context = context.active(),
): NodeJS.ProcessEnv {
	ensureW3cPropagator();
	const carrier: Record<string, string> = {};
	propagation.inject(ctx, carrier);
	const next = { ...env };
	if (carrier.traceparent) next.TRACEPARENT = carrier.traceparent;
	if (carrier.tracestate) next.TRACESTATE = carrier.tracestate;
	if (parentSessionId) next.ALEF_PARENT_SESSION_ID = parentSessionId;
	return next;
}

/** True when headless/createAgent should mount OTel (CLI always does). */
export function shouldEnableOTelForAgent(): boolean {
	return process.env.ALEF_OTEL === "1" || Boolean(process.env.TRACEPARENT?.trim());
}

/** Rebuild processors with SQLite (+ OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set). */
export async function upgradeToSqliteExporter(): Promise<void> {
	if (!provider) return;
	const processors = await buildProcessors(true);
	await provider.shutdown();
	provider = new NodeTracerProvider({ spanProcessors: processors });
	provider.register();
	if (sessionSpan && !sessionSpan.isRecording()) {
		activateInheritedTraceContext();
	} else if (sessionSpan) {
		enterContext(trace.setSpan(extractInheritedContext(), sessionSpan));
	}
}

/** Flush pending spans and print a token-usage summary to stderr. */
export async function shutdownOTel(): Promise<void> {
	if (!provider) return;

	sessionSpan?.end();
	sessionSpan = undefined;

	await provider.shutdown();
	provider = undefined;

	const spans = memoryExporter?.getFinishedSpans() ?? [];
	memoryExporter = undefined;
	const chatSpans = spans.filter((s) => s.name.startsWith("chat "));

	if (chatSpans.length === 0) return;

	let inputTokens = 0;
	let outputTokens = 0;
	let totalCostUsd = 0;

	for (const s of chatSpans) {
		const attrs = s.attributes;
		const inputVal = attrs["gen_ai.usage.input_tokens"];
		const outputVal = attrs["gen_ai.usage.output_tokens"];
		const costVal = attrs["alef.estimated_cost_usd"];
		inputTokens += typeof inputVal === "number" ? inputVal : 0;
		outputTokens += typeof outputVal === "number" ? outputVal : 0;
		totalCostUsd += typeof costVal === "number" ? costVal : 0;
	}

	process.stderr.write(
		`\n[session] ${chatSpans.length} LLM call${chatSpans.length !== 1 ? "s" : ""} · ` +
			`${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out · ` +
			`$${totalCostUsd.toFixed(COST_FRACTION_DIGITS)}\n`,
	);
}
