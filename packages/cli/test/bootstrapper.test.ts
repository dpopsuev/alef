/**
 * Bootstrapper lifecycle event contract tests.
 *
 * Validates the BootEvent discriminated union, BootHandle pub/sub,
 * and that the TuiShell.handleBootEvent interface can consume every variant.
 */

import { describe, expect, it } from "vitest";
import type { BootEvent, BootEventListener, BootHandle } from "../src/boot/bootstrapper.js";

/** Minimal BootHandle implementation for testing the pub/sub contract. */
function createTestHandle(): BootHandle & { emit(event: BootEvent): void; resolve(): void } {
	const listeners = new Set<BootEventListener>();
	let resolveDone: () => void;
	const done = new Promise<void>((r) => {
		resolveDone = r;
	});
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of listeners) listener(event);
		},
		resolve() {
			resolveDone();
		},
		done,
	};
}

describe("BootEvent discriminated union", { tags: ["unit"] }, () => {
	it("every phase/status combination is distinguishable", () => {
		const events: BootEvent[] = [
			{ phase: "storage", status: "starting" },
			{ phase: "storage", status: "ready" },
			{ phase: "session", status: "picking" },
			{ phase: "session", status: "ready", sessionId: "s1", isNew: true },
			{ phase: "adapters", status: "loading" },
			{ phase: "adapters", status: "ready", adapterCount: 5, blueprintName: "coding" },
			{ phase: "model", status: "ready", modelId: "claude-sonnet-4-5" },
			{ phase: "agent", status: "wiring" },
			{ phase: "agent", status: "ready" },
			{ phase: "error", error: "storage init failed" },
		];

		// Each event is a unique phase+status pair
		const keys = events.map((e) => `${e.phase}:${"status" in e ? e.status : e.error}`);
		expect(new Set(keys).size).toBe(events.length);
	});

	it("narrowing works on phase field", () => {
		const event: BootEvent = { phase: "session", status: "ready", sessionId: "abc", isNew: false };
		if (event.phase === "session" && event.status === "ready") {
			// TypeScript narrows to the specific variant
			expect(event.sessionId).toBe("abc");
			expect(event.isNew).toBe(false);
		}
	});

	it("narrowing works on error phase", () => {
		const event: BootEvent = { phase: "error", error: "boom" };
		if (event.phase === "error") {
			expect(event.error).toBe("boom");
		}
	});
});

describe("BootHandle pub/sub", { tags: ["unit"] }, () => {
	it("delivers events to subscribers", () => {
		const handle = createTestHandle();
		const received: BootEvent[] = [];
		handle.subscribe((e) => received.push(e));

		handle.emit({ phase: "storage", status: "starting" });
		handle.emit({ phase: "storage", status: "ready" });

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual({ phase: "storage", status: "starting" });
		expect(received[1]).toEqual({ phase: "storage", status: "ready" });
	});

	it("unsubscribe stops delivery", () => {
		const handle = createTestHandle();
		const received: BootEvent[] = [];
		const unsub = handle.subscribe((e) => received.push(e));

		handle.emit({ phase: "storage", status: "starting" });
		unsub();
		handle.emit({ phase: "storage", status: "ready" });

		expect(received).toHaveLength(1);
	});

	it("multiple subscribers each receive all events", () => {
		const handle = createTestHandle();
		const a: BootEvent[] = [];
		const b: BootEvent[] = [];
		handle.subscribe((e) => a.push(e));
		handle.subscribe((e) => b.push(e));

		handle.emit({ phase: "agent", status: "ready" });

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it("done resolves when boot completes", async () => {
		const handle = createTestHandle();
		let resolved = false;
		void handle.done.then(() => {
			resolved = true;
		});

		expect(resolved).toBe(false);
		handle.resolve();
		await handle.done;
		expect(resolved).toBe(true);
	});
});

describe("handleBootEvent exhaustiveness", { tags: ["unit"] }, () => {
	it("a switch over phase covers every variant without default", () => {
		// This is a compile-time check disguised as a runtime test.
		// If a new BootEvent variant is added, this function must be updated
		// or TypeScript reports a type error on the exhaustive check.
		function handleBootEvent(event: BootEvent): string {
			switch (event.phase) {
				case "storage":
					return `storage:${event.status}`;
				case "session":
					return event.status === "ready" ? `session:${event.sessionId}` : "session:picking";
				case "adapters":
					return event.status === "ready" ? `adapters:${event.adapterCount}` : "adapters:loading";
				case "model":
					return `model:${event.modelId}`;
				case "agent":
					return `agent:${event.status}`;
				case "error":
					return `error:${event.error}`;
			}
			// If this line is reachable, the switch is not exhaustive.
			// TypeScript ensures `event` is `never` here.
			const _exhaustive: never = event;
			return _exhaustive;
		}

		expect(handleBootEvent({ phase: "storage", status: "starting" })).toBe("storage:starting");
		expect(handleBootEvent({ phase: "error", error: "x" })).toBe("error:x");
		expect(handleBootEvent({ phase: "model", status: "ready", modelId: "m1" })).toBe("model:m1");
	});
});
