/**
 * SessionLog — tap command and event buses, write every event to the session JSONL.
 *
 * Same wildcard pattern as EvaluatorAdapter: subscribes command/* and event/*.
 * Writes each event as a StorageRecord to the session file (fire-and-forget).
 *
 * This is the missing link between the EDA bus and the persistent event log.
 * Once wired, the TurnAssembler can read the full event history
 * and build accurate context windows without relying on AgentController.history[].
 *
 * Not a tool-bearing adapter — no tools, no subscriptions via defineAdapter.
 * Implements Adapter directly (same as EvaluatorAdapter).
 *
 */

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { SessionStore } from "@dpopsuev/alef-session";
import type { ActorIdentity } from "./identity/actor.js";
import { redactPayload } from "./redact.js";
import { type BusKind, hashRecord, type StorageActor } from "./session-store.js";

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

export class SessionLog implements Adapter {
	readonly name = "event-log";
	readonly tools = [] as const;
	readonly subscriptions = {
		command: ["*"] as const,
		event: ["*"] as const,
		notification: ["*"] as const,
	};
	readonly sources: readonly { readonly name: string; readonly kind: "file" | "memory" | "process" }[] = [
		{ name: "session-store", kind: "file" },
	];

	private readonly store: SessionStore;
	private readonly model: string;
	private readonly agentActor: StorageActor | undefined;
	private readonly _summaryWriter?: (summary: SessionSummary) => void | Promise<void>;

	constructor(
		store: SessionStore,
		model = "unknown",
		agentIdentity?: ActorIdentity,
		summaryWriter?: (summary: SessionSummary) => void | Promise<void>,
	) {
		this.store = store;
		this.model = model;
		this.agentActor = agentIdentity ? { address: agentIdentity.address, type: agentIdentity.type } : undefined;
		this._summaryWriter = summaryWriter;
	}

	mount(bus: Bus): () => void {
		const startedAt = Date.now();
		let turns = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let errors = 0;
		const toolCounts = new Map<string, number>();

		const offAgg1 = bus.command.subscribe("*", (event) => {
			if (event.type === "llm.response") {
				turns++;
				const u = (event.payload as { usage?: { input?: number; output?: number } }).usage;
				if (u) {
					inputTokens += u.input ?? 0;
					outputTokens += u.output ?? 0;
				}
			} else {
				toolCounts.set(event.type, (toolCounts.get(event.type) ?? 0) + 1);
			}
		});
		const offAgg2 = bus.event.subscribe("*", (event) => {
			if (event.isError) errors++;
		});

		const sessionId = this.store.id;
		const agentActor = this.agentActor;

		const off1 = bus.command.subscribe("*", (event) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- redactPayload preserves object structure
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const bus: BusKind = "command";
			const base = {
				bus,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
				elapsed: event.elapsed,
				sessionId,
				actor: agentActor,
			};
			this.store
				.append({ ...base, hash: hashRecord(base) })
				.catch((e: unknown) => traceEvent("event-log:command-append-failed", { error: String(e) }));
		});

		const off2 = bus.event.subscribe("*", (event) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- redactPayload preserves object structure
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			// llm.input is the human's message — stamp as human actor when sender indicates so
			const isHumanInput = event.type === "llm.input" && (payload.sender === "human" || payload.sender === "user");
			const senderStr = typeof payload.sender === "string" ? payload.sender : "human";
			const actor: StorageActor | undefined = isHumanInput
				? { address: `@${senderStr}`, type: "human" }
				: agentActor;
			const eventBus: BusKind = "event";
			const base = {
				bus: eventBus,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
				elapsed: event.elapsed,
				sessionId,
				actor,
			};
			this.store
				.append({ ...base, hash: hashRecord(base) })
				.catch((e: unknown) => traceEvent("event-log:sense-append-failed", { error: String(e) }));
		});

		const off3 = bus.notification.subscribe("*", (event) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- redactPayload preserves object structure
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const notifBus: BusKind = "notification";
			const base = {
				bus: notifBus,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
				elapsed: event.elapsed,
				sessionId,
				actor: agentActor,
			};
			this.store
				.append({ ...base, hash: hashRecord(base) })
				.catch((e: unknown) => traceEvent("event-log:signal-append-failed", { error: String(e) }));
		});

		return () => {
			offAgg1();
			offAgg2();
			off1();
			off2();
			off3();
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
		if (this._summaryWriter) {
			try {
				await this._summaryWriter(summary);
			} catch (e: unknown) {
				traceEvent("session-summary:sqlite-failed", { error: String(e) });
			}
		}
		const json = `${JSON.stringify(summary, null, 2)}\n`;
		const last = join(homedir(), ".alef", "last-session.json");
		await writeFile(last, json, "utf-8").catch((e: unknown) =>
			traceEvent("session-summary:write-failed", { path: last, error: String(e) }),
		);
	}
}
