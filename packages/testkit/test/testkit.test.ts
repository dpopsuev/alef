import { Agent } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { BusEventRecorder, MockReasoner } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(cannedText = "mock response") {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {} });
	agent.load(dialog).load(new MockReasoner(cannedText));
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
// MockReasoner
// ---------------------------------------------------------------------------

describe("MockReasoner", { tags: ["unit"] }, () => {
	it("dialog.send() resolves with canned text", async () => {
		const { agent: _agent, dialog } = make("hello from mock");
		const reply = await dialog.send("hi");
		expect(reply).toBe("hello from mock");
	});

	it("canned text is configurable", async () => {
		const { agent: _agent, dialog } = make("custom reply");
		expect(await dialog.send("anything")).toBe("custom reply");
	});

	it("emits Motor/llm.response with canned text", async () => {
		const { agent: _agent, dialog, recorder } = make("response text");
		await dialog.send("hi");
		const msg = recorder.assertMotorEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("response text");
	});
});

// ---------------------------------------------------------------------------
// BusEventRecorder
// ---------------------------------------------------------------------------

describe("BusEventRecorder", { tags: ["unit"] }, () => {
	it("records Motor/llm.response", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertMotorEmitted("llm.response");
	});

	it("records Sense/llm.input", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertSenseEmitted("llm.input");
	});

	it("records Motor/llm.response", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertMotorEmitted("llm.response");
	});

	it("records Sense/llm.input", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("ping");
		recorder.assertSenseEmitted("llm.input");
	});

	it("assertSenseEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertSenseEmitted("llm.input")).toThrow("Expected Sense/llm.input");
	});

	it("assertMotorEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertMotorEmitted("llm.response")).toThrow("Expected Motor/llm.response");
	});

	it("clear() resets all recorded events", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("first");
		recorder.clear();
		expect(recorder.sense).toHaveLength(0);
		expect(recorder.motor).toHaveLength(0);
	});

	it("assertCorrelationPaired passes when both buses carry the id", async () => {
		const { agent: _agent, dialog, recorder } = make();
		await dialog.send("ping");
		const msg = recorder.assertMotorEmitted("llm.response");
		expect(() => recorder.assertCorrelationPaired(msg.correlationId)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("Harness round-trip", { tags: ["unit"] }, () => {
	it("resolves with canned text", async () => {
		const { agent: _agent, dialog } = make("pong");
		expect(await dialog.send("ping")).toBe("pong");
	});

	it("full event sequence: llm.input → llm.response → llm.input → llm.response", async () => {
		const { agent: _agent, dialog, recorder } = make("done");
		await dialog.send("start");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
	});
});
