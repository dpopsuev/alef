import { describe, expect, it, vi } from "vitest";
import { type BusMessage, newCorrelationId } from "../src/buses.js";
import { InProcessBus } from "../src/in-process-bus.js";

// ---------------------------------------------------------------------------
// Register test event schemas via module augmentation.
// ---------------------------------------------------------------------------

declare module "../src/buses.js" {
	interface CommandMessageRegistry {
		"test.command": { value: string };
		"test.tool_call": { toolName: string; args: Record<string, unknown> };
	}
	interface EventMessageRegistry {
		"test.result": { output: string };
		"test.observation": { data: unknown };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommandMessage(
	type: "test.command" | "test.tool_call" = "test.command",
	correlationId = newCorrelationId(),
) {
	if (type === "test.command") {
		return { type, payload: { value: "hello" }, correlationId } as const;
	}
	return { type, payload: { toolName: "bash", args: {} }, correlationId } as const;
}

function makeEventMessage(
	type: "test.result" | "test.observation" = "test.result",
	correlationId = newCorrelationId(),
) {
	if (type === "test.result") {
		return { type, payload: { output: "done" }, correlationId, isError: false } as const;
	}
	return { type, payload: { data: 42 }, correlationId, isError: false } as const;
}

// ---------------------------------------------------------------------------
// Nerve — event.subscribe, command.subscribe, command.publish, event.publish
// ---------------------------------------------------------------------------

describe("Nerve — event.subscribe", { tags: ["unit"] }, () => {
	it("delivers event message to subscriber", () => {
		const nerve = new InProcessBus();
		const reasoner = nerve.asBus();
		const received: BusMessage[] = [];
		reasoner.event.subscribe("test.result", (e) => void received.push(e));

		nerve.asBus().event.publish(makeEventMessage("test.result"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.result" });
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessBus();
		const reasoner = nerve.asBus();
		const received: BusMessage[] = [];
		const off = reasoner.event.subscribe("test.result", (e) => void received.push(e));

		nerve.asBus().event.publish(makeEventMessage("test.result"));
		off();
		nerve.asBus().event.publish(makeEventMessage("test.result"));

		expect(received).toHaveLength(1);
	});

	it("does not receive wrong event type", () => {
		const nerve = new InProcessBus();
		const reasoner = nerve.asBus();
		const received: BusMessage[] = [];
		reasoner.event.subscribe("test.result", (e) => void received.push(e));

		nerve.asBus().event.publish(makeEventMessage("test.observation"));

		expect(received).toHaveLength(0);
	});
});

describe("Nerve — command.publish", { tags: ["unit"] }, () => {
	it("delivers command message to subscriber", () => {
		const nerve = new InProcessBus();
		const reasoner = nerve.asBus();
		const adapter = nerve.asBus();
		const received: BusMessage[] = [];
		adapter.command.subscribe("test.command", (e) => void received.push(e));

		reasoner.command.publish(makeCommandMessage("test.command"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "test.command" });
	});
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("Nerve — command.subscribe", { tags: ["unit"] }, () => {
	it("delivers command message to subscriber", () => {
		const nerve = new InProcessBus();
		const adapter = nerve.asBus();
		const received: BusMessage[] = [];
		adapter.command.subscribe("test.command", (e) => void received.push(e));

		nerve.publish("command", makeCommandMessage("test.command"));

		expect(received).toHaveLength(1);
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessBus();
		const adapter = nerve.asBus();
		const received: BusMessage[] = [];
		const off = adapter.command.subscribe("test.command", (e) => void received.push(e));

		nerve.publish("command", makeCommandMessage("test.command"));
		off();
		nerve.publish("command", makeCommandMessage("test.command"));

		expect(received).toHaveLength(1);
	});
});

describe("Nerve — event.publish", { tags: ["unit"] }, () => {
	it("delivers event message to subscriber", () => {
		const nerve = new InProcessBus();
		const adapter = nerve.asBus();
		const reasoner = nerve.asBus();
		const received: BusMessage[] = [];
		reasoner.event.subscribe("test.result", (e) => void received.push(e));

		adapter.event.publish(makeEventMessage("test.result"));

		expect(received).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Agent root methods
// ---------------------------------------------------------------------------

describe("InProcessBus — bus root methods", { tags: ["unit"] }, () => {
	it("publishCommand reaches CommandBus subscriber", () => {
		const nerve = new InProcessBus();
		const received: BusMessage[] = [];
		nerve.asBus().command.subscribe("test.command", (e) => void received.push(e));

		nerve.publish("command", makeCommandMessage("test.command"));

		expect(received).toHaveLength(1);
	});

	it("subscribeEvent receives from EventBus publish", () => {
		const nerve = new InProcessBus();
		const received: BusMessage[] = [];
		nerve.subscribe("event", "test.result", (e) => void received.push(e));

		nerve.asBus().event.publish(makeEventMessage("test.result"));

		expect(received).toHaveLength(1);
	});

	it("correlationId threads through Command→Event round-trip", () => {
		const nerve = new InProcessBus();
		const id = newCorrelationId();
		let received: BusMessage | undefined;

		nerve.asBus().command.subscribe("test.command", (commandMessage) => {
			nerve.asBus().event.publish({
				type: "test.result",
				payload: { output: "echo" },
				correlationId: commandMessage.correlationId,
				isError: false,
			});
		});
		nerve.subscribe("event", "test.result", (e) => {
			received = e;
		});

		nerve.publish("command", {
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

describe("InProcessBus — wildcard subscriptions", { tags: ["unit"] }, () => {
	it("onAnyCommand receives all command messages", () => {
		const nerve = new InProcessBus();
		const received: BusMessage[] = [];
		nerve.onAny("command", (e) => received.push(e));

		nerve.publish("command", makeCommandMessage("test.command"));
		nerve.publish("command", makeCommandMessage("test.tool_call"));

		expect(received).toHaveLength(2);
	});

	it("onAnyEvent receives all event messages", () => {
		const nerve = new InProcessBus();
		const received: BusMessage[] = [];
		nerve.onAny("event", (e) => received.push(e));

		nerve.asBus().event.publish(makeEventMessage("test.result"));
		nerve.asBus().event.publish(makeEventMessage("test.observation"));

		expect(received).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// listenerCount
// ---------------------------------------------------------------------------

describe("InProcessBus — listenerCount", { tags: ["unit"] }, () => {
	it("returns 0 for unregistered type", () => {
		const nerve = new InProcessBus();
		expect(nerve.listenerCount("command", "test.command")).toBe(0);
	});

	it("counts and decrements correctly", () => {
		const nerve = new InProcessBus();
		const off1 = nerve.asBus().command.subscribe("test.command", vi.fn());
		const off2 = nerve.asBus().command.subscribe("test.command", vi.fn());
		expect(nerve.listenerCount("command", "test.command")).toBe(2);
		off1();
		expect(nerve.listenerCount("command", "test.command")).toBe(1);
		off2();
		expect(nerve.listenerCount("command", "test.command")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// InProcessBus.firstSeen LRU cap
// ---------------------------------------------------------------------------

describe("InProcessBus.firstSeen LRU cap", { tags: ["unit"] }, () => {
	it("firstSeen size stays bounded after many unique correlationIds", () => {
		const nerve = new InProcessBus();
		const n = nerve.asBus();

		// Subscribe so events don't go to dead-letter (which returns immediately).
		n.command.subscribe("test.command", () => {});

		// Publish more events than the cap (FIRST_SEEN_MAX = 500) with unique correlationIds.
		// Without event-eviction, the LRU cap is the only bound.
		const OVER_CAP = 700;
		for (let i = 0; i < OVER_CAP; i++) {
			n.command.publish({ type: "test.command", payload: { value: `x${i}` }, correlationId: `corr-${i}` });
		}

		// Access internals via reflection.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const commandBus = (nerve as any)._buses.command as { firstSeen: Map<string, number> };

		expect(commandBus.firstSeen.size).toBeLessThanOrEqual(500);
	});

	it("firstSeen entries are evicted after correlation completes", async () => {
		const nerve = new InProcessBus();
		const n = nerve.asBus();
		const correlationId = "eviction-test";

		// Complete a full request/response cycle.
		n.command.subscribe("test.command", () => {
			// tool handler publishes the event response
			n.event.publish({ type: "test.result", payload: { output: "done" }, correlationId, isError: false });
		});
		n.command.publish({ type: "test.command", payload: { value: "hi" }, correlationId });

		// Allow event loop to settle.
		await new Promise((r) => setTimeout(r, 10));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const commandBus = (nerve as any)._buses.command as { firstSeen: Map<string, number> };
		expect(commandBus.firstSeen.has(correlationId)).toBe(false);
	});
});
