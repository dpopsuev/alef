import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { BusEventRecorder, MockReasoner } from "../src/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(cannedText = "mock response") {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	agent.load(new MockReasoner(cannedText));
	agent.observe(recorder);
	const controller = new AgentController(agent);
	return { agent, controller, recorder, dispose: () => agent.dispose() };
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
	it("controller.send() resolves with canned text", async () => {
		const { agent: _agent, controller } = make("hello from mock");
		const reply = await controller.send("hi");
		expect(reply).toBe("hello from mock");
	});

	it("canned text is configurable", async () => {
		const { agent: _agent, controller } = make("custom reply");
		expect(await controller.send("anything")).toBe("custom reply");
	});

	it("emits Motor/llm.response with canned text", async () => {
		const { agent: _agent, controller, recorder } = make("response text");
		await controller.send("hi");
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
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertMotorEmitted("llm.response");
	});

	it("records Sense/llm.input", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertSenseEmitted("llm.input");
	});

	it("records Motor/llm.response", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertMotorEmitted("llm.response");
	});

	it("records Sense/llm.input", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
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
		const { agent: _agent, controller, recorder } = make();
		await controller.send("first");
		recorder.clear();
		expect(recorder.sense).toHaveLength(0);
		expect(recorder.motor).toHaveLength(0);
	});

	it("assertCorrelationPaired passes when both buses carry the id", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		const msg = recorder.assertMotorEmitted("llm.response");
		expect(() => recorder.assertCorrelationPaired(msg.correlationId)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe("Harness round-trip", { tags: ["unit"] }, () => {
	it("resolves with canned text", async () => {
		const { agent: _agent, controller } = make("pong");
		expect(await controller.send("ping")).toBe("pong");
	});

	it("full event sequence: llm.input → llm.response → llm.input → llm.response", async () => {
		const { agent: _agent, controller, recorder } = make("done");
		await controller.send("start");

		const motorTypes = recorder.motor.map((e) => e.type);
		const senseTypes = recorder.sense.map((e) => e.type);

		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
	});
});
