/**
 * SQLite span exporter — persists OTel spans for causal DAG queries.
 *
 * Replaces InMemorySpanExporter. Every span created by the dispatch
 * framework (tool calls) and reasoner (LLM calls) is persisted with
 * parentSpanId for backward causality walking.
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Client } from "@libsql/client";

export class SqliteSpanExporter implements SpanExporter {
	private readonly db: Client;
	private _stopped = false;

	constructor(db: Client) {
		this.db = db;
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		if (this._stopped) {
			resultCallback({ code: ExportResultCode.FAILED });
			return;
		}

		void this.writeSpans(spans)
			.then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
			.catch(() => resultCallback({ code: ExportResultCode.FAILED }));
	}

	async shutdown(): Promise<void> {
		this._stopped = true;
	}

	async forceFlush(): Promise<void> {}

	private async writeSpans(spans: ReadableSpan[]): Promise<void> {
		if (spans.length === 0) return;

		const stmts = spans.map((span) => {
			const ctx = span.spanContext();
			const parentId = span.parentSpanContext?.spanId ?? null;
			const sessionId =
				(span.attributes["alef.session.id"] as string) ??
				(span.attributes["alef.correlation.id"] as string)?.slice(0, 8) ??
				null;

			return {
				sql: `INSERT OR IGNORE INTO spans
					(span_id, trace_id, parent_span_id, name, kind, start_time, end_time, status, attributes, events, session_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					ctx.spanId,
					ctx.traceId,
					parentId,
					span.name,
					span.kind,
					Math.floor(span.startTime[0] * 1000 + span.startTime[1] / 1e6),
					Math.floor(span.endTime[0] * 1000 + span.endTime[1] / 1e6),
					span.status.code,
					JSON.stringify(span.attributes),
					JSON.stringify(span.events.map((e) => ({ name: e.name, time: e.time, attributes: e.attributes }))),
					sessionId,
				],
			};
		});

		await this.db.batch(stmts, "write");
	}

	getFinishedSpans(): ReadableSpan[] {
		return [];
	}

	reset(): void {}
}
