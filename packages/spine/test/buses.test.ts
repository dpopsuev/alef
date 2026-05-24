import { describe, expect, it, vi } from "vitest";
import { InProcessNerve, type NerveEvent, newCorrelationId } from "../src/buses.js";

// ---------------------------------------------------------------------------
// Register test event schemas via module augmentation.
// ---------------------------------------------------------------------------

declare module "../src/buses.js" {
	interface MotorEventRegistry {
		"test.command": { value: string };
		"test.tool_call": { toolName: string; args: Record<string, unknown> };
	}
	interface SenseEventRegistry {
		"test.result": { output: string };
		"test.observation": { data: unknown };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMotorEvent(type: "test.command" | "test.tool_call" = "test.command", correlationId = newCorrelationId()) {
	if (type === "test.command") {
		return { type, payload: { value: "hello" }, correlationId } as const;
	}
	return { type, payload: { toolName: "bash", args: {} }, correlationId } as const;
}

function makeSenseEvent(type: "test.result" | "test.observation" = "test.result", correlationId = newCorrelationId()) {
	if (type === "test.result") {
		return { type, payload: { output: "done" }, correlationId, isError: false } as const;
	}
	return { type, payload: { data: 42 }, correlationId, isError: false } as const;
}

// ---------------------------------------------------------------------------
// Nerve — sense.subscribe, motor.subscribe, motor.publish, sense.publish
// ---------------------------------------------------------------------------

describe("Nerve — sense.subscribe", () => {
	it("delivers sense event to subscriber", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.result" });
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asNerve();
		const received: NerveEvent[] = [];
		const off = cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asNerve().sense.publish(makeSenseEvent("test.result"));
		off();
		nerve.asNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});

	it("does not receive wrong event type", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asNerve().sense.publish(makeSenseEvent("test.observation"));

		expect(received).toHaveLength(0);
	});
});

describe("Nerve — motor.publish", () => {
	it("delivers motor event to subscriber", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asNerve();
		const corpus = nerve.asNerve();
		const received: NerveEvent[] = [];
		corpus.motor.subscribe("test.command", (e) => void received.push(e));

		cerebrum.motor.publish(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.command" });
	});
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("Nerve — motor.subscribe", () => {
	it("delivers motor event to subscriber", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asNerve();
		const received: NerveEvent[] = [];
		corpus.motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asNerve();
		const received: NerveEvent[] = [];
		const off = corpus.motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));
		off();
		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});
});

describe("Nerve — sense.publish", () => {
	it("delivers sense event to subscriber", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asNerve();
		const cerebrum = nerve.asNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		corpus.sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Agent root methods
// ---------------------------------------------------------------------------

describe("InProcessNerve — corpus root methods", () => {
	it("publishMotor reaches CorpusNerve subscriber", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.asNerve().motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});

	it("subscribeSense receives from CorpusNerve publish", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.subscribeSense("test.result", (e) => void received.push(e));

		nerve.asNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});

	it("correlationId threads through Motor→Sense round-trip", () => {
		const nerve = new InProcessNerve();
		const id = newCorrelationId();
		let received: NerveEvent | undefined;

		nerve.asNerve().motor.subscribe("test.command", (motorEvent) => {
			nerve.asNerve().sense.publish({
				type: "test.result",
				payload: { output: "echo" },
				correlationId: motorEvent.correlationId,
				isError: false,
			});
		});
		nerve.subscribeSense("test.result", (e) => {
			received = e;
		});

		nerve.publishMotor({
			type: "test.command",
			payload: { value: "ping" },
			correlationId: id,
		});

		expect(received?.correlationId).toBe(id);
	});
});

// ---------------------------------------------------------------------------
// Wildcard subscriptions (for BusEventRecorder)
// ---------------------------------------------------------------------------

describe("InProcessNerve — wildcard subscriptions", () => {
	it("onAnyMotor receives all motor events", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.onAnyMotor((e) => received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));
		nerve.publishMotor(makeMotorEvent("test.tool_call"));

		expect(received).toHaveLength(2);
	});

	it("onAnySense receives all sense events", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.onAnySense((e) => received.push(e));

		nerve.asNerve().sense.publish(makeSenseEvent("test.result"));
		nerve.asNerve().sense.publish(makeSenseEvent("test.observation"));

		expect(received).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// listenerCount
// ---------------------------------------------------------------------------

describe("InProcessNerve — listenerCount", () => {
	it("returns 0 for unregistered type", () => {
		const nerve = new InProcessNerve();
		expect(nerve.listenerCount("motor", "test.command")).toBe(0);
	});

	it("counts and decrements correctly", () => {
		const nerve = new InProcessNerve();
		const off1 = nerve.asNerve().motor.subscribe("test.command", vi.fn());
		const off2 = nerve.asNerve().motor.subscribe("test.command", vi.fn());
		expect(nerve.listenerCount("motor", "test.command")).toBe(2);
		off1();
		expect(nerve.listenerCount("motor", "test.command")).toBe(1);
		off2();
		expect(nerve.listenerCount("motor", "test.command")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// RED: ALE-BUG-15 — firstSeen Map grows unboundedly (memory leak)
// ---------------------------------------------------------------------------

describe("RED: ALE-BUG-15 — InProcessBus.firstSeen memory leak", () => {
	it("firstSeen size stays bounded after many unique correlationIds", () => {
		const nerve = new InProcessNerve();
		const n = nerve.asNerve();

		// Subscribe so events don't go to dead-letter (which returns immediately).
		n.motor.subscribe("test.command", () => {});

		// Publish 200 events each with a unique correlationId.
		const LIMIT = 200;
		for (let i = 0; i < LIMIT; i++) {
			n.motor.publish({ type: "test.command", payload: { value: `x${i}` }, correlationId: `corr-${i}` });
		}

		// Access internals via reflection.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const motorBus = (nerve as any)._motor as { firstSeen: Map<string, number> };

		// RED: currently firstSeen.size === 200 — it should be bounded by some cap.
		// After the fix, size must be ≤ cap (e.g. ≤ 100).
		expect(motorBus.firstSeen.size).toBeLessThanOrEqual(100);
	});

	it("firstSeen entries are evicted after correlation completes", async () => {
		const nerve = new InProcessNerve();
		const n = nerve.asNerve();
		const correlationId = "eviction-test";

		// Complete a full request/response cycle.
		n.motor.subscribe("test.command", () => {
			// tool handler publishes the sense response
			n.sense.publish({ type: "test.result", payload: { output: "done" }, correlationId, isError: false });
		});
		n.motor.publish({ type: "test.command", payload: { value: "hi" }, correlationId });

		// Allow event loop to settle.
		await new Promise((r) => setTimeout(r, 10));

		// RED: after the correlation is resolved, firstSeen should not retain the entry.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const motorBus = (nerve as any)._motor as { firstSeen: Map<string, number> };
		expect(motorBus.firstSeen.has(correlationId)).toBe(false);
	});
});
