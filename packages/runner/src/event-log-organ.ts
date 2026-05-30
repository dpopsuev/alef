/**
 * SessionLog — tap Motor and Sense buses, write every event to the session JSONL.
 *
 * Same wildcard pattern as EvaluatorOrgan: subscribes motor/* and sense/*.
 * Writes each event as a StorageRecord to the session file (fire-and-forget).
 *
 * This is the missing link between the EDA bus and the persistent event log.
 * Once wired, the TurnAssembler (ALE-TSK-179) can read the full event history
 * and build accurate context windows without relying on DialogOrgan.history[].
 *
 * Not a CorpusOrgan — no tools, no subscriptions via defineOrgan.
 * Implements Organ directly (same as EvaluatorOrgan).
 *
 * Ref: ALE-SPC-15, ALE-TSK-178
 */

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { type BusKind, hashRecord, type SessionStore } from "@dpopsuev/alef-spine";
import { trace } from "./debug-trace.js";
import { redactPayload } from "./redact.js";

export interface SessionSummary {
	id: string;
	model: string;
	started_at: string;
	duration_ms: number;
	turns: number;
	tokens: { input: number; output: number };
	tools: Array<{ name: string; calls: number }>;
	errors: number;
}

export class SessionLog implements Organ {
	readonly name = "event-log";
	readonly tools = [] as const;
	readonly subscriptions = {
		motor: ["*"] as const,
		sense: ["*"] as const,
	};

	private readonly store: SessionStore;
	private readonly model: string;

	constructor(store: SessionStore, model = "unknown") {
		this.store = store;
		this.model = model;
	}

	mount(nerve: Nerve): () => void {
		const startedAt = Date.now();
		let turns = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let errors = 0;
		const toolCounts = new Map<string, number>();

		const offAgg1 = nerve.motor.subscribe("*", (event) => {
			if (event.type === "dialog.message") {
				turns++;
				const u = (event.payload as { usage?: { input?: number; output?: number } }).usage;
				if (u) {
					inputTokens += u.input ?? 0;
					outputTokens += u.output ?? 0;
				}
			} else if (!event.type.startsWith("llm.")) {
				toolCounts.set(event.type, (toolCounts.get(event.type) ?? 0) + 1);
			}
		});
		const offAgg2 = nerve.sense.subscribe("*", (event) => {
			if (event.isError) errors++;
		});

		const off1 = nerve.motor.subscribe("*", (event) => {
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const base = {
				bus: "motor" as BusKind,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
				elapsed: event.elapsed,
			};
			this.store
				.append({ ...base, hash: hashRecord(base) })
				.catch((e: unknown) => trace("event-log:motor-append-failed", { error: String(e) }));
		});

		const off2 = nerve.sense.subscribe("*", (event) => {
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const base = {
				bus: "sense" as BusKind,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
				elapsed: event.elapsed,
			};
			this.store
				.append({ ...base, hash: hashRecord(base) })
				.catch((e: unknown) => trace("event-log:sense-append-failed", { error: String(e) }));
		});

		return () => {
			offAgg1();
			offAgg2();
			off1();
			off2();
			void this._writeSummary({
				id: this.store.id,
				model: this.model,
				started_at: new Date(startedAt).toISOString(),
				duration_ms: Date.now() - startedAt,
				turns,
				tokens: { input: inputTokens, output: outputTokens },
				tools: [...toolCounts.entries()]
					.map(([name, calls]) => ({ name, calls }))
					.sort((a, b) => b.calls - a.calls),
				errors,
			});
		};
	}

	private async _writeSummary(summary: SessionSummary): Promise<void> {
		const json = `${JSON.stringify(summary, null, 2)}\n`;
		const perSession = this.store.path.replace(/\.jsonl$/, ".summary.json");
		const last = join(homedir(), ".alef", "last-session.json");
		await Promise.all([
			writeFile(perSession, json, "utf-8").catch((e: unknown) =>
				trace("session-summary:write-failed", { path: perSession, error: String(e) }),
			),
			writeFile(last, json, "utf-8").catch((e: unknown) =>
				trace("session-summary:write-failed", { path: last, error: String(e) }),
			),
		]);
	}
}
