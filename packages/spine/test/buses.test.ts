/**
 * Nerve typed Pub-Sub — SenseBus, MotorBus, SignalBus.
 *
 * Pure in-memory. No I/O, no organs, no process spawn.
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessNerve, type MotorEvent, newCorrelationId, type SenseEvent, type SignalEvent } from "../src/buses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(text = "hello", correlationId = newCorrelationId()) {
	return {
		type: "user_message" as const,
		text,
		tools: [],
		correlationId,
		timestamp: Date.now(),
	};
}

function makeToolResult(toolName = "file_read", correlationId = newCorrelationId()) {
	return {
		type: "tool_result" as const,
		toolName,
		result: "file contents",
		isError: false,
		correlationId,
		timestamp: Date.now(),
	};
}

function makeLLMRequest(correlationId = newCorrelationId()) {
	return {
		type: "llm_request" as const,
		messages: [{ role: "user", content: "hello" }],
		tools: [],
		correlationId,
		timestamp: Date.now(),
	};
}

function makeToolCall(toolName = "file_read", correlationId = newCorrelationId()) {
	return {
		type: "tool_call" as const,
		toolName,
		args: { path: "/tmp/test.ts" },
		correlationId,
		timestamp: Date.now(),
	};
}

function makeUserReply(text = "world", correlationId = newCorrelationId()) {
	return {
		type: "user_reply" as const,
		text,
		correlationId,
		timestamp: Date.now(),
	};
}

function makeSignal(correlationId = newCorrelationId()) {
	return {
		type: "signal" as const,
		signal: "execute" as const,
		organ: "llm",
		correlationId,
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// SenseBus
// ---------------------------------------------------------------------------

describe("InProcessNerve — SenseBus", () => {
	it("delivers user_message to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.sense.on("user_message", (e) => void received.push(e));

		const event = makeUserMessage("ping");
		nerve.sense.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "user_message", text: "ping" });
	});

	it("delivers tool_result to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.sense.on("tool_result", (e) => void received.push(e));

		nerve.sense.emit(makeToolResult("bash"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "tool_result", toolName: "bash" });
	});

	it("does not deliver to wrong event type", () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.sense.on("tool_result", (e) => void received.push(e));

		nerve.sense.emit(makeUserMessage());

		expect(received).toHaveLength(0);
	});

	it("delivers to multiple subscribers for same type", () => {
		const nerve = new InProcessNerve();
		const a: SenseEvent[] = [];
		const b: SenseEvent[] = [];
		nerve.sense.on("user_message", (e) => void a.push(e));
		nerve.sense.on("user_message", (e) => void b.push(e));

		nerve.sense.emit(makeUserMessage());

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		const off = nerve.sense.on("user_message", (e) => void received.push(e));

		nerve.sense.emit(makeUserMessage("first"));
		off();
		nerve.sense.emit(makeUserMessage("second"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ text: "first" });
	});

	it("carries correlationId through", () => {
		const nerve = new InProcessNerve();
		const id = newCorrelationId();
		let received: SenseEvent | undefined;
		nerve.sense.on("user_message", (e) => {
			received = e;
		});

		nerve.sense.emit(makeUserMessage("hi", id));

		expect(received?.correlationId).toBe(id);
	});
});

// ---------------------------------------------------------------------------
// MotorBus
// ---------------------------------------------------------------------------

describe("InProcessNerve — MotorBus", () => {
	it("delivers llm_request to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: MotorEvent[] = [];
		nerve.motor.on("llm_request", (e) => void received.push(e));

		nerve.motor.emit(makeLLMRequest());

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("llm_request");
	});

	it("delivers tool_call to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: MotorEvent[] = [];
		nerve.motor.on("tool_call", (e) => void received.push(e));

		nerve.motor.emit(makeToolCall("bash"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "tool_call", toolName: "bash" });
	});

	it("delivers user_reply to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: MotorEvent[] = [];
		nerve.motor.on("user_reply", (e) => void received.push(e));

		nerve.motor.emit(makeUserReply("done"));

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "user_reply", text: "done" });
	});

	it("tool_call subscribers can filter by toolName", () => {
		const nerve = new InProcessNerve();
		const fileReads: MotorEvent[] = [];
		const bashCalls: MotorEvent[] = [];

		nerve.motor.on("tool_call", (e) => {
			if (e.type === "tool_call" && e.toolName === "file_read") void fileReads.push(e);
			if (e.type === "tool_call" && e.toolName === "bash") void bashCalls.push(e);
		});

		nerve.motor.emit(makeToolCall("file_read"));
		nerve.motor.emit(makeToolCall("bash"));

		expect(fileReads).toHaveLength(1);
		expect(bashCalls).toHaveLength(1);
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const received: MotorEvent[] = [];
		const off = nerve.motor.on("llm_request", (e) => void received.push(e));

		nerve.motor.emit(makeLLMRequest());
		off();
		nerve.motor.emit(makeLLMRequest());

		expect(received).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// SignalBus
// ---------------------------------------------------------------------------

describe("InProcessNerve — SignalBus", () => {
	it("delivers signal events to subscriber", () => {
		const nerve = new InProcessNerve();
		const received: SignalEvent[] = [];
		nerve.signal.on("signal", (e) => void received.push(e));

		nerve.signal.emit(makeSignal());

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("signal");
	});

	it("unsubscribes cleanly", () => {
		const nerve = new InProcessNerve();
		const received: SignalEvent[] = [];
		const off = nerve.signal.on("signal", (e) => void received.push(e));

		nerve.signal.emit(makeSignal());
		off();
		nerve.signal.emit(makeSignal());

		expect(received).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Buses are independent — events on one bus don't bleed to others
// ---------------------------------------------------------------------------

describe("InProcessNerve — bus isolation", () => {
	it("sense and motor buses are independent", () => {
		const nerve = new InProcessNerve();
		const senseReceived: SenseEvent[] = [];
		const motorReceived: MotorEvent[] = [];

		nerve.sense.on("user_message", (e) => void senseReceived.push(e));
		nerve.motor.on("user_reply", (e) => void motorReceived.push(e));

		nerve.sense.emit(makeUserMessage());
		nerve.motor.emit(makeUserReply());

		expect(senseReceived).toHaveLength(1);
		expect(motorReceived).toHaveLength(1);
		expect(senseReceived[0]?.type).toBe("user_message");
		expect(motorReceived[0]?.type).toBe("user_reply");
	});
});

// ---------------------------------------------------------------------------
// listenerCount helper
// ---------------------------------------------------------------------------

describe("InProcessNerve — listenerCount", () => {
	it("returns 0 for unregistered type", () => {
		const nerve = new InProcessNerve();
		expect(nerve.listenerCount("sense", "user_message")).toBe(0);
	});

	it("counts registered handlers", () => {
		const nerve = new InProcessNerve();
		const off1 = nerve.sense.on("user_message", vi.fn());
		const off2 = nerve.sense.on("user_message", vi.fn());
		expect(nerve.listenerCount("sense", "user_message")).toBe(2);
		off1();
		expect(nerve.listenerCount("sense", "user_message")).toBe(1);
		off2();
		expect(nerve.listenerCount("sense", "user_message")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Async handlers — fire-and-forget, errors don't propagate to emit()
// ---------------------------------------------------------------------------

describe("InProcessNerve — async handlers", () => {
	it("async handler receives event", async () => {
		const nerve = new InProcessNerve();
		let resolved = false;
		nerve.sense.on("user_message", async () => {
			await Promise.resolve();
			resolved = true;
		});

		nerve.sense.emit(makeUserMessage());
		await Promise.resolve(); // flush microtasks
		await Promise.resolve();

		expect(resolved).toBe(true);
	});
});
