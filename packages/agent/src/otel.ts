/**
 * OTel setup for the Alef runner.
 *
 * Registers a NodeTracerProvider with an InMemorySpanExporter.
 * At shutdown, prints a session summary to stderr:
 *   - Number of LLM calls (chat spans)
 *   - Total input/output tokens
 *   - Estimated cost (USD)
 *
 * For durable span export, wire a file exporter here.
 */

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let exporter: InMemorySpanExporter | undefined;
let provider: NodeTracerProvider | undefined;

export function setupOTel(): void {
	exporter = new InMemorySpanExporter();
	// Pass spanProcessors at construction — this version does not expose addSpanProcessor.
	provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	provider.register();
}

export async function shutdownOTel(): Promise<void> {
	if (!provider || !exporter) return;

	await provider.shutdown();

	const spans = exporter.getFinishedSpans();
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
