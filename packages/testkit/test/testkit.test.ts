import { Agent } from "@dpopsuev/alef-corpus";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { BusEventRecorder, MockLLMOrgan } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(cannedText = "mock response") {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
	agent.load(dialog).load(new MockLLMOrgan(cannedText));
	agent.observe(recorder);
	return { agent, dialog, recorder, dispose: () => agent.dispose() };
}

const harnesses: ReturnType<typeof makeHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make(canned?: string) {
	const h = makeHarness(canned);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// MockLLMOrgan
// ---------------------------------------------------------------------------

describe("MockLLMOrgan", () => {
	it("dialog.send() resolves with canned text", async () => {
		const { agent: _corpus, dialog } = make("hello from mock");
		const reply = await dialog.send("hi");
		expect(reply).toBe("hello from mock");
	});

	it("canned text is configurable", async () => {
		const { agent: _corpus, dialog } = make("custom reply");
		expect(await dialog.send("anything")).toBe("custom reply");
	});

	it("emits Motor/dialog.message with canned text", async () => {
		const { agent: _corpus, dialog, recorder } = make("response text");
		await dialog.send("hi");
		const msg = recorder.assertMotorEmitted("dialog.message");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("response text");
	});
});

// ---------------------------------------------------------------------------
// BusEventRecorder
// ---------------------------------------------------------------------------

describe("BusEventRecorder", () => {
	it("records Motor/dialog.message", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertMotorEmitted("dialog.message");
	});

	it("records Sense/dialog.message", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertSenseEmitted("dialog.message");
	});

	it("records Motor/dialog.message", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertMotorEmitted("dialog.message");
	});

	it("records Sense/dialog.message", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertSenseEmitted("dialog.message");
	});

	it("assertSenseEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertSenseEmitted("dialog.message")).toThrow("Expected Sense/dialog.message");
	});

	it("assertMotorEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertMotorEmitted("dialog.message")).toThrow("Expected Motor/dialog.message");
	});

	it("clear() resets all recorded events", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("first");
		recorder.clear();
		expect(recorder.sense).toHaveLength(0);
		expect(recorder.motor).toHaveLength(0);
	});

	it("assertCorrelationPaired passes when both buses carry the id", async () => {
		const { agent: _corpus, dialog, recorder } = make();
		await dialog.send("ping");
		const msg = recorder.assertMotorEmitted("dialog.message");
		expect(() => recorder.assertCorrelationPaired(msg.correlationId)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("Harness round-trip", () => {
	it("resolves with canned text", async () => {
		const { agent: _corpus, dialog } = make("pong");
		expect(await dialog.send("ping")).toBe("pong");
	});

	it("full event sequence: dialog.message → dialog.message → dialog.message → dialog.message", async () => {
		const { agent: _corpus, dialog, recorder } = make("done");
		await dialog.send("start");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("dialog.message");
		expect(senseTypes).toContain("dialog.message");
		expect(motorTypes).toContain("dialog.message");
		expect(senseTypes).toContain("dialog.message");
	});
});
