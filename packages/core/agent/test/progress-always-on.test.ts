/**
 * Production-readiness: ProgressTelemetry always-on + headless bus contract.
 */

import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { newCorrelationId, type NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/create-agent-session.js";

const MODEL: Model<Api> = {
	id: "progress-test",
	name: "progress-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

async function createRuntime(getGap?: () => { totalMagnitude: number; converged: boolean }) {
	return createAgentSession({
		cwd: process.cwd(),
		model: MODEL,
		adapters: [],
		llmAdapter: stubLlm(),
		composeToolShell: false,
		getGap,
	});
}

/** Minimal LLM stub — no tools, no API. */
function stubLlm(): Adapter {
	return {
		name: "stub-llm",
		tools: [],
		subscriptions: { command: ["llm.response"] as const, event: [] as const, notification: [] as const },
		sources: [{ name: "llm.response", kind: "memory" }],
		mount() {
			return () => {};
		},
	};
}

describe("ProgressTelemetry always-on", { tags: ["unit"] }, () => {
	it("createAgentSession mounts progress-telemetry without opt-in", async () => {
		const runtime = await createRuntime();
		expect(runtime.agent.adapters.some((adapter) => adapter.name === "progress-telemetry")).toBe(true);
		expect(runtime.agent.adapters.some((adapter) => adapter.name === "loop-detector")).toBe(true);
		await runtime.dispose();
	});

	it("emits telemetry.progress.step with tok/P when gap shrinks", async () => {
		let gap = 10;
		const runtime = await createRuntime(() => ({ totalMagnitude: gap, converged: gap === 0 }));
		const { agent } = runtime;
		const steps: Array<Record<string, unknown>> = [];
		agent.asBus().notification.subscribe("telemetry.progress.step", (event: NotificationMessage) => {
			steps.push(event.payload);
		});
		await agent.ready();

		const correlationId = newCorrelationId();
		agent.asBus().event.publish({
			type: "llm.input",
			payload: { text: "hi" },
			correlationId,
			isError: false,
		});
		gap = 4;
		agent.asBus().notification.publish({
			type: "llm.token-usage",
			payload: { usage: { input: 20, output: 10, totalTokens: 30 } },
			correlationId,
		});
		agent.asBus().command.publish({
			type: "llm.response",
			payload: { text: "ok" },
			correlationId,
		});

		expect(steps).toHaveLength(1);
		expect(steps[0]!.progress).toBe(6);
		expect(steps[0]!.tok_per_progress).toBe(5);
		await runtime.dispose();
	});

	it("headless composition root emits progress on bus without /metrics", async () => {
		let gap = 8;
		const runtime = await createRuntime(() => ({ totalMagnitude: gap, converged: false }));
		const { agent } = runtime;
		const steps: Array<Record<string, unknown>> = [];
		agent.asBus().notification.subscribe("telemetry.progress.step", (event) => {
			steps.push(event.payload);
		});
		await agent.ready();

		const correlationId = newCorrelationId();
		agent.asBus().event.publish({
			type: "llm.input",
			payload: { text: "headless" },
			correlationId,
			isError: false,
		});
		gap = 3;
		agent.asBus().notification.publish({
			type: "llm.token-usage",
			payload: { usage: { input: 5, output: 5, totalTokens: 10 } },
			correlationId,
		});
		agent.asBus().command.publish({
			type: "llm.response",
			payload: { text: "done" },
			correlationId,
		});

		expect(steps).toHaveLength(1);
		expect(steps[0]!.tok_per_progress).toBe(2);
		await runtime.dispose();
	});
});
