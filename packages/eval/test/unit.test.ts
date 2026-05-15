/**
 * Unit tests — no infrastructure, no OTel, no filesystem.
 *
 * Layer 1: EvaluatorOrgan event counting and loop detection.
 * Layer 2: scoreSpans() pure scoring function.
 */

import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { EvaluatorOrgan } from "../src/evaluator-organ.js";
import type { SpanRecord } from "../src/metrics.js";
import { READ_ONLY_RULES, scoreSpans, WRITE_RULES } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNerve() {
	const nerve = new InProcessNerve();
	return nerve.asNerve();
}

function motorEvent(type: string, correlationId = "c1") {
	return { type, correlationId, timestamp: Date.now(), payload: {} };
}

function senseEvent(type: string, correlationId = "c1") {
	return {
		type,
		correlationId,
		timestamp: Date.now(),
		payload: {},
		isError: false,
	};
}

function span(name: string, attrs: Record<string, unknown> = {}): SpanRecord {
	return { name, attributes: attrs, status: "OK", durationMs: 1 };
}

// ---------------------------------------------------------------------------
// Layer 1: EvaluatorOrgan
// ---------------------------------------------------------------------------

describe("EvaluatorOrgan — event counting", () => {
	it("counts motor events", () => {
		const n = makeNerve();
		const organ = new EvaluatorOrgan();
		organ.mount(n);

		n.motor.publish(motorEvent("fs.read"));
		n.motor.publish(motorEvent("fs.grep"));
		n.motor.publish(motorEvent("shell.exec"));

		expect(organ.state.motorCount).toBe(3);
	});

	it("counts sense events", () => {
		const n = makeNerve();
		const organ = new EvaluatorOrgan();
		organ.mount(n);

		n.sense.publish(senseEvent("fs.read"));
		n.sense.publish(senseEvent("fs.read"));

		expect(organ.state.senseCount).toBe(2);
	});

	it("starts with no loop detected", () => {
		const organ = new EvaluatorOrgan();
		expect(organ.state.loopDetected).toBe(false);
		expect(organ.state.loopEventType).toBeUndefined();
	});

	it("unmount stops counting", () => {
		const nerve = new InProcessNerve();
		const n = nerve.asNerve();
		const organ = new EvaluatorOrgan();
		const unmount = organ.mount(n);

		n.motor.publish(motorEvent("fs.read"));
		expect(organ.state.motorCount).toBe(1);

		unmount();
		n.motor.publish(motorEvent("fs.read"));
		expect(organ.state.motorCount).toBe(1); // still 1
	});
});

describe("EvaluatorOrgan — loop detection", () => {
	it("detects loop when same event type exceeds threshold on same correlationId", () => {
		const n = makeNerve();
		const loopCalls: string[] = [];
		const organ = new EvaluatorOrgan({
			loopThreshold: 3,
			onLoop: (type) => loopCalls.push(type),
		});
		organ.mount(n);

		for (let i = 0; i < 5; i++) {
			n.motor.publish(motorEvent("fs.read", "corr-1"));
		}

		expect(organ.state.loopDetected).toBe(true);
		expect(organ.state.loopEventType).toBe("fs.read");
		expect(loopCalls).toContain("fs.read");
	});

	it("does not flag loop below threshold", () => {
		const n = makeNerve();
		const organ = new EvaluatorOrgan({ loopThreshold: 10 });
		organ.mount(n);

		for (let i = 0; i < 5; i++) {
			n.motor.publish(motorEvent("fs.read", "corr-1"));
		}

		expect(organ.state.loopDetected).toBe(false);
	});

	it("counts per correlationId independently", () => {
		const n = makeNerve();
		const organ = new EvaluatorOrgan({ loopThreshold: 3 });
		organ.mount(n);

		// 3 events on corr-1, 3 events on corr-2 — neither exceeds threshold of 3
		for (let i = 0; i < 3; i++) {
			n.motor.publish(motorEvent("fs.read", "corr-1"));
			n.motor.publish(motorEvent("fs.read", "corr-2"));
		}

		expect(organ.state.loopDetected).toBe(false);
	});

	it("different event types on same correlationId do not trigger loop", () => {
		const n = makeNerve();
		const organ = new EvaluatorOrgan({ loopThreshold: 3 });
		organ.mount(n);

		n.motor.publish(motorEvent("fs.read", "c1"));
		n.motor.publish(motorEvent("fs.grep", "c1"));
		n.motor.publish(motorEvent("fs.find", "c1"));
		n.motor.publish(motorEvent("shell.exec", "c1"));

		expect(organ.state.loopDetected).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Layer 2: scoreSpans()
// ---------------------------------------------------------------------------

describe("scoreSpans — ReadOnly rules", () => {
	it("awards points for fs.read spans", () => {
		const spans = [span("alef.motor/fs.read"), span("alef.motor/fs.read")];
		expect(scoreSpans(spans, READ_ONLY_RULES)).toBe(20); // 2 × 10
	});

	it("awards points for fs.grep spans", () => {
		expect(scoreSpans([span("alef.motor/fs.grep")], READ_ONLY_RULES)).toBe(5);
	});

	it("penalises fs.write spans", () => {
		expect(scoreSpans([span("alef.motor/fs.write")], READ_ONLY_RULES)).toBe(-15);
	});

	it("penalises fs.edit spans", () => {
		expect(scoreSpans([span("alef.motor/fs.edit")], READ_ONLY_RULES)).toBe(-15);
	});

	it("mixed read+write nets correctly", () => {
		const spans = [
			span("alef.motor/fs.read"), // +10
			span("alef.motor/fs.grep"), // +5
			span("alef.motor/fs.write"), // -15
		];
		expect(scoreSpans(spans, READ_ONLY_RULES)).toBe(0);
	});

	it("returns 0 for empty spans", () => {
		expect(scoreSpans([], READ_ONLY_RULES)).toBe(0);
	});
});

describe("scoreSpans — Write rules", () => {
	it("rewards fs.write spans", () => {
		expect(scoreSpans([span("alef.motor/fs.write")], WRITE_RULES)).toBe(15);
	});

	it("rewards fs.edit spans", () => {
		expect(scoreSpans([span("alef.motor/fs.edit")], WRITE_RULES)).toBe(10);
	});
});

describe("scoreSpans — attribute filter", () => {
	it("only scores spans matching attribute filter", () => {
		const rules = [{ match: "alef.motor/fs.read", points: 5, attribute: { key: "alef.cache.hit", value: true } }];
		const spans = [
			span("alef.motor/fs.read", { "alef.cache.hit": true }), // matches → +5
			span("alef.motor/fs.read", { "alef.cache.hit": false }), // no match → 0
		];
		expect(scoreSpans(spans, rules)).toBe(5);
	});
});
