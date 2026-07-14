/**
 * Token telemetry adapter — comprehensive LLM token usage tracking with attribution.
 *
 * Subscribes to llm.token-usage events, enriches with adapter/tool/model context,
 * and persists to JSONL for cost analysis and optimization.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, NotificationMessage } from "@dpopsuev/alef-kernel/bus";

const TELEMETRY_ROOT = join(homedir(), ".alef", "telemetry");

/** Compact token usage record for JSONL storage. */
interface TokenTelemetryRecord {
	ts: number; // timestamp
	sid: string; // sessionId
	cid: string; // correlationId
	adapter?: string; // adapter name (when available)
	tool?: string; // tool name (when available)
	model?: string; // model ID (when available)
	turn?: number; // turn number (when available)
	round?: number; // round within turn (when available)
	op?: string; // operation type: "reply" | "tool-calling" | "compaction" | "steering"
	tokens: {
		in: number;
		out: number;
		cr: number; // cacheRead
		cw: number; // cacheWrite
		total: number;
	};
	cost: {
		in: number;
		out: number;
		cr: number;
		cw: number;
		total: number;
	};
}

/**
 * Token telemetry store — appends token usage records to session-specific JSONL files.
 */
class TokenTelemetryStore {
	private readonly sessionId: string;
	private readonly path: string;
	private writeCount = 0;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.path = join(TELEMETRY_ROOT, `${sessionId}-tokens.jsonl`);
	}

	async ensureDir(): Promise<void> {
		await mkdir(TELEMETRY_ROOT, { recursive: true });
	}

	async append(record: TokenTelemetryRecord): Promise<void> {
		if (this.writeCount === 0) {
			await this.ensureDir();
		}
		const line = `${JSON.stringify(record)}\n`;
		await appendFile(this.path, line, "utf-8");
		this.writeCount++;
	}
}

/**
 * Context tracker — maintains turn/round state and recent tool calls for attribution.
 */
class TelemetryContext {
	private turnNumber = 0;
	private roundNumber = 0;
	private lastToolCalls: Map<string, string> = new Map(); // correlationId -> toolName
	private adapterName?: string;
	private modelId?: string;

	setAdapter(name: string): void {
		this.adapterName = name;
	}

	setModel(id: string): void {
		this.modelId = id;
	}

	onTurnStart(): void {
		this.turnNumber++;
		this.roundNumber = 0;
	}

	onRound(): void {
		this.roundNumber++;
	}

	onToolCall(correlationId: string, toolName: string): void {
		this.lastToolCalls.set(correlationId, toolName);
	}

	getToolName(correlationId: string): string | undefined {
		return this.lastToolCalls.get(correlationId);
	}

	getState() {
		return {
			adapter: this.adapterName,
			model: this.modelId,
			turn: this.turnNumber,
			round: this.roundNumber,
		};
	}
}

/**
 * Create token telemetry adapter.
 */
export function createTokenTelemetry(sessionId: string): Adapter {
	const store = new TokenTelemetryStore(sessionId);
	const context = new TelemetryContext();

	return defineAdapter(
		"token-telemetry",
		{
			event: {
				"adapter.loaded": {
					handle() {
						return Promise.resolve();
					},
				},
			},
		},
		{
			description: "Token telemetry — tracks LLM token usage with adapter/tool attribution for cost analysis.",
			directives: [],
			sources: [{ name: "notification-bus", kind: "memory" }],
			onMount(bus: Bus) {
				bus.notification.subscribe("*", async (event: NotificationMessage) => {
					const { type, payload, correlationId } = event;

					// Track tool calls for attribution
					if (type === "llm.tool-start") {
						const toolName = typeof payload.name === "string" ? payload.name : "unknown";
						context.onToolCall(correlationId, toolName);
					}

					// Track turn boundaries
					if (type === "llm.turn-start") {
						context.onTurnStart();
					}

					// Track rounds within turn
					if (type === "llm.round-start") {
						context.onRound();
					}

					// Capture token usage
					if (type === "llm.token-usage") {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol
						const usage = payload.usage as {
							input: number;
							output: number;
							totalTokens: number;
							costUsd?: number;
							cacheRead?: number;
							cacheWrite?: number;
							modelId?: string;
						} | undefined;

						if (!usage) return;

						if (usage.modelId) context.setModel(usage.modelId);
						const state = context.getState();
						const toolName = context.getToolName(correlationId);

						const record: TokenTelemetryRecord = {
							ts: Date.now(),
							sid: sessionId,
							cid: correlationId,
							adapter: state.adapter,
							tool: toolName,
							model: state.model,
							turn: state.turn,
							round: state.round,
							tokens: {
								in: usage.input,
								out: usage.output,
								cr: usage.cacheRead ?? 0,
								cw: usage.cacheWrite ?? 0,
								total: usage.totalTokens,
							},
							cost: {
								in: 0, // TODO: calculate from model pricing
								out: 0,
								cr: 0,
								cw: 0,
								total: usage.costUsd ?? 0,
							},
						};

						await store.append(record);
					}
				});
			},
		},
	);
}
