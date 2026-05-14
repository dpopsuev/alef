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
		return { type, payload: { value: "hello" }, correlationId, timestamp: Date.now() } as const;
	}
	return { type, payload: { toolName: "bash", args: {} }, correlationId, timestamp: Date.now() } as const;
}

function makeSenseEvent(type: "test.result" | "test.observation" = "test.result", correlationId = newCorrelationId()) {
	if (type === "test.result") {
		return { type, payload: { output: "done" }, correlationId, timestamp: Date.now(), isError: false } as const;
	}
	return { type, payload: { data: 42 }, correlationId, timestamp: Date.now(), isError: false } as const;
}

// ---------------------------------------------------------------------------
// CerebrumNerve — sense.subscribe, motor.publish
// ---------------------------------------------------------------------------

describe("CerebrumNerve — sense.subscribe", () => {
	it("delivers sense event to subscriber", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asCerebrumNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.result" });
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asCerebrumNerve();
		const received: NerveEvent[] = [];
		const off = cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.result"));
		off();
		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});

	it("does not receive wrong event type", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asCerebrumNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.observation"));

		expect(received).toHaveLength(0);
	});
});

describe("CerebrumNerve — motor.publish", () => {
	it("delivers motor event to CorpusNerve subscriber", () => {
		const nerve = new InProcessNerve();
		const cerebrum = nerve.asCerebrumNerve();
		const corpus = nerve.asCorpusNerve();
		const received: NerveEvent[] = [];
		corpus.motor.subscribe("test.command", (e) => void received.push(e));

		cerebrum.motor.publish(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.command" });
	});
});

// ---------------------------------------------------------------------------
// CorpusNerve — motor.subscribe, sense.publish
// ---------------------------------------------------------------------------

describe("CorpusNerve — motor.subscribe", () => {
	it("delivers motor event to subscriber", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asCorpusNerve();
		const received: NerveEvent[] = [];
		corpus.motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asCorpusNerve();
		const received: NerveEvent[] = [];
		const off = corpus.motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));
		off();
		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});
});

describe("CorpusNerve — sense.publish", () => {
	it("delivers sense event to CerebrumNerve subscriber", () => {
		const nerve = new InProcessNerve();
		const corpus = nerve.asCorpusNerve();
		const cerebrum = nerve.asCerebrumNerve();
		const received: NerveEvent[] = [];
		cerebrum.sense.subscribe("test.result", (e) => void received.push(e));

		corpus.sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Corpus root methods
// ---------------------------------------------------------------------------

describe("InProcessNerve — corpus root methods", () => {
	it("publishMotor reaches CorpusNerve subscriber", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.asCorpusNerve().motor.subscribe("test.command", (e) => void received.push(e));

		nerve.publishMotor(makeMotorEvent("test.command"));

		expect(received).toHaveLength(1);
	});

	it("subscribeSense receives from CorpusNerve publish", () => {
		const nerve = new InProcessNerve();
		const received: NerveEvent[] = [];
		nerve.subscribeSense("test.result", (e) => void received.push(e));

		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.result"));

		expect(received).toHaveLength(1);
	});

	it("correlationId threads through Motor→Sense round-trip", () => {
		const nerve = new InProcessNerve();
		const id = newCorrelationId();
		let received: NerveEvent | undefined;

		nerve.asCorpusNerve().motor.subscribe("test.command", (motorEvent) => {
			nerve.asCorpusNerve().sense.publish({
				type: "test.result",
				payload: { output: "echo" },
				correlationId: motorEvent.correlationId,
				timestamp: Date.now(),
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
			timestamp: Date.now(),
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

		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.result"));
		nerve.asCorpusNerve().sense.publish(makeSenseEvent("test.observation"));

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
		const off1 = nerve.asCorpusNerve().motor.subscribe("test.command", vi.fn());
		const off2 = nerve.asCorpusNerve().motor.subscribe("test.command", vi.fn());
		expect(nerve.listenerCount("motor", "test.command")).toBe(2);
		off1();
		expect(nerve.listenerCount("motor", "test.command")).toBe(1);
		off2();
		expect(nerve.listenerCount("motor", "test.command")).toBe(0);
	});
});
