/**
 * Inner agent event transparency — agent.run.inner signal events
 *
 * Given/When/Then:
 *   Given a strategy that calls onInnerEvent during send()
 *   When DelegateOrgan dispatches agent.run
 *   Then signal/agent.run.inner events appear on the outer nerve's signal bus
 *     with the callId and innerType from the inner event
 */

import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";
import { NerveFixture } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createDelegateOrgan } from "../src/organ.js";

describe("agent.run.inner signal events", { tags: ["unit"] }, () => {
	it("strategy onInnerEvent fires signal/agent.run.inner on the outer nerve", async () => {
		const capturedInnerEvents: Array<{ callId: string; innerType: string; innerPayload: Record<string, unknown> }> =
			[];

		// A strategy that simulates an inner agent reading a file and thinking.
		const strategy: ExecutionStrategy = {
			async send({ text, onChunk, onInnerEvent }) {
				// Simulate inner agent emitting motor events.
				onInnerEvent?.("tc-inner-1", "fs.read", { path: "src/agent.ts", toolCallId: "tc-inner-1" });
				onInnerEvent?.("tc-inner-2", "llm.thinking", { text: "Let me read this file..." });
				onChunk?.("the answer");
				return `done: ${text}`;
			},
		};

		const f = new NerveFixture();
		const organ = createDelegateOrgan({ strategies: { explore: strategy } });
		f.mount(organ);

		// Subscribe to outer signal bus for inner events.
		f.nerve.asNerve().signal.subscribe("agent.run.inner", (event) => {
			const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
			capturedInnerEvents.push({
				callId: String(p.callId ?? ""),
				innerType: String(p.innerType ?? ""),
				innerPayload: (p.innerPayload as Record<string, unknown>) ?? {},
			});
		});

		await new Promise<void>((resolve) => {
			f.nerve.asNerve().sense.subscribe("agent.run", (e) => {
				if ((e.payload as { isFinal?: boolean }).isFinal === true || e.isError) resolve();
			});
			f.nerve.asNerve().motor.publish({
				type: "agent.run",
				payload: { text: "read the codebase", profile: "explore", toolCallId: "tc-outer-1" },
				correlationId: "corr-outer-1",
			});
		});

		expect(capturedInnerEvents).toHaveLength(2);
		expect(capturedInnerEvents[0].innerType).toBe("fs.read");
		expect(capturedInnerEvents[0].callId).toBe("tc-outer-1");
		expect(capturedInnerEvents[1].innerType).toBe("llm.thinking");

		f.dispose();
	});
});
