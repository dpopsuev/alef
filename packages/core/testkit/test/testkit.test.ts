import { Agent, AgentController } from "@dpopsuev/alef-engine";
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

	it("emits Command/llm.response with canned text", async () => {
		const { agent: _agent, controller, recorder } = make("response text");
		await controller.send("hi");
		const msg = recorder.assertCommandEmitted("llm.response");
		const payload = (msg as unknown as { payload: { text: string } }).payload;
		expect(payload.text).toBe("response text");
	});
});

// ---------------------------------------------------------------------------
// BusEventRecorder
// ---------------------------------------------------------------------------

describe("BusEventRecorder", { tags: ["unit"] }, () => {
	it("records Command/llm.response", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertCommandEmitted("llm.response");
	});

	it("records Event/llm.input", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertEventEmitted("llm.input");
	});

	it("records Command/llm.response", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertCommandEmitted("llm.response");
	});

	it("records Event/llm.input", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		recorder.assertEventEmitted("llm.input");
	});

	it("assertEventEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertEventEmitted("llm.input")).toThrow("Expected Event/llm.input");
	});

	it("assertCommandEmitted throws with helpful message when missing", () => {
		const recorder = new BusEventRecorder();
		expect(() => recorder.assertCommandEmitted("llm.response")).toThrow("Expected Command/llm.response");
	});

	it("clear() resets all recorded events", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("first");
		recorder.clear();
		expect(recorder.event).toHaveLength(0);
		expect(recorder.command).toHaveLength(0);
	});

	it("assertCorrelationPaired passes when both buses carry the id", async () => {
		const { agent: _agent, controller, recorder } = make();
		await controller.send("ping");
		const msg = recorder.assertCommandEmitted("llm.response");
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

		const motorTypes = recorder.command.map((e) => e.type);
		const senseTypes = recorder.event.map((e) => e.type);

		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
		expect(motorTypes).toContain("llm.response");
		expect(senseTypes).toContain("llm.input");
	});
});
