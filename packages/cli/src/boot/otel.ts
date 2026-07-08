/**
 * OTel setup for the Alef runner.
 *
 * Registers a NodeTracerProvider with a SqliteSpanExporter that persists
 * every span to the session database. The causal DAG (parent-child span
 * relationships) is preserved for backward causality walking.
 *
 * Falls back to InMemorySpanExporter if the database is not available.
 */

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let memoryExporter: InMemorySpanExporter | undefined;
let provider: NodeTracerProvider | undefined;

/** Register the OTel tracer provider with an in-memory span exporter and auto-instrumentation. */
export function setupOTel(): void {
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
}

/** Replace the in-memory exporter with a SQLite-backed one once the database is available. */
export async function upgradeToSqliteExporter(): Promise<void> {
	if (!provider) return;
	try {
		const { getDatabase } = await import("@dpopsuev/alef-storage/sqlite/database");
		const { SqliteSpanExporter } = await import("@dpopsuev/alef-storage/sqlite/span-exporter");
		const db = await getDatabase();
		const sqliteExporter = new SqliteSpanExporter(db);

		await provider.shutdown();
		provider = new NodeTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(memoryExporter!), new SimpleSpanProcessor(sqliteExporter)],
		});
		provider.register();
	} catch {
		// Database not available — keep in-memory exporter
	}
}

/** Flush pending spans and print a token-usage summary to stderr. */
export async function shutdownOTel(): Promise<void> {
	if (!provider) return;

	await provider.shutdown();

	const spans = memoryExporter?.getFinishedSpans() ?? [];
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
			`$${totalCostUsd.toFixed(4)}\n`,
	);
}
