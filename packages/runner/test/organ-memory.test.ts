/**
 * MemoryOrgan unit tests — Phase 1 skeleton.
 *
 * Verifies:
 *   - organ mounts, satisfies contract (name, tools, subscriptions)
 *   - participates in llm.phase pipeline with empty response (no messages field)
 *   - does not override ToolShell messages in a two-stage pipeline
 *
 * Ref: ALE-SPC-55, ALE-TSK-457
 */

import { randomUUID } from "node:crypto";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryOrgan } from "../src/organ-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountOrgan(organ: ReturnType<typeof createMemoryOrgan>) {
	const nerve = new InProcessNerve();
	const unmount = organ.mount(nerve.asNerve());
	return { nerve, unmount };
}

function firePhase(nerve: InProcessNerve, messages: unknown[]): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const correlationId = randomUUID();
		const timer = setTimeout(() => resolve(null), 500);
		const off = nerve.asNerve().sense.subscribe("llm.phase", (event) => {
			if (event.correlationId !== correlationId) return;
			clearTimeout(timer);
			off();
			resolve(event.payload as Record<string, unknown>);
		});
		nerve.asNerve().motor.publish({
			type: "llm.phase",
			payload: { messages, turn: 1, toolCount: 0 },
			correlationId,
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryOrgan — Phase 1 skeleton", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("has name=memory and no LLM-callable tools", () => {
		const organ = createMemoryOrgan();
		expect(organ.name).toBe("memory");
		expect(organ.tools).toHaveLength(0);
	});

	it("subscribes to motor/llm.phase", () => {
		const organ = createMemoryOrgan();
		expect(organ.subscriptions.motor).toContain("llm.phase");
	});

	it("mount returns a cleanup function and unmount is idempotent", () => {
		const organ = createMemoryOrgan();
		const { unmount } = mountOrgan(organ);
		disposes.push(unmount);
		expect(() => {
			unmount();
			unmount();
		}).not.toThrow();
	});

	it("publishes sense/llm.phase with no messages field on each motor/llm.phase event", async () => {
		const organ = createMemoryOrgan();
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const payload = await firePhase(nerve, [{ role: "user", content: "hello" }]);
		expect(payload).not.toBeNull();
		// Phase 1: empty response — messages key must be absent so ToolShell wins.
		expect(payload).not.toHaveProperty("messages");
	});

	it("does not block the pipeline when sessionStore is absent", async () => {
		const organ = createMemoryOrgan({ sessionStore: () => undefined });
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const payload = await firePhase(nerve, []);
		expect(payload).not.toBeNull();
	});
});
