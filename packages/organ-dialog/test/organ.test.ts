import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it, vi } from "vitest";
import { DialogOrgan } from "../src/organ.js";

organComplianceSuite(() => new DialogOrgan({ sink: () => {} }));

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve(), organNerve: nerve.asNerve(), reasoner: nerve.asNerve() };
}

describe("DialogOrgan", { tags: ["compliance"] }, () => {
	it("has name=dialog, no tools", () => {
		const organ = new DialogOrgan();
		expect(organ.name).toBe("dialog");
		expect(organ.tools).toHaveLength(0);
	});

	it("unmount clears the nerve ref", () => {
		const { nerve, organNerve } = makeNerve();
		const organ = new DialogOrgan();
		const unmount = organ.mount(organNerve);
		expect(nerve.listenerCount("motor", "llm.response")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "llm.response")).toBe(0);
		expect(() => organ.receive("hi")).toThrow("not mounted");
	});

	it('receive() publishes Sense/"llm.input" with text and sender', () => {
		const { organNerve, reasoner } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(organNerve);

		const received: unknown[] = [];
		reasoner.sense.subscribe("llm.input", (e) => {
			received.push(e);
		});

		organ.receive("hello", "human");

		expect(received).toHaveLength(1);
		const event = received[0] as { payload: { text: string; sender: string } };
		expect(event.payload.text).toBe("hello");
		expect(event.payload.sender).toBe("human");
	});

	it("receive() defaults sender to 'human'", () => {
		const { organNerve, reasoner } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(organNerve);

		const received: unknown[] = [];
		reasoner.sense.subscribe("llm.input", (e) => {
			received.push(e);
		});
		organ.receive("test");

		const event = received[0] as { payload: { sender: string } };
		expect(event.payload.sender).toBe("human");
	});

	it("receive() accepts any sender — human, agent, system", () => {
		const { organNerve, reasoner } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(organNerve);

		const senders: string[] = [];
		reasoner.sense.subscribe("llm.input", (e) => {
			senders.push((e.payload as { sender: string }).sender);
		});

		organ.receive("ping", "human");
		organ.receive("forward", "agent:planner");
		organ.receive("boot", "system");

		expect(senders).toEqual(["human", "agent:planner", "system"]);
	});

	it('Motor/"llm.response" from LLM routes to sink', () => {
		const sink = vi.fn();
		const { organNerve, reasoner } = makeNerve();
		const organ = new DialogOrgan({ sink });
		organ.mount(organNerve);

		reasoner.motor.publish({
			type: "llm.response",
			payload: { text: "done", sender: "agent" },
			correlationId: "c1",
		});

		expect(sink).toHaveBeenCalledWith("done", "agent");
	});

	it("sender() returns correlationId for correlation", () => {
		const { organNerve, reasoner } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(organNerve);

		const ids: string[] = [];
		reasoner.sense.subscribe("llm.input", (e) => {
			ids.push(e.correlationId);
		});

		const s = organ.sender("human");
		const id = s.send("hello");

		expect(ids).toHaveLength(1);
		expect(ids[0]).toBe(id);
	});
});

describe("DialogOrgan — receive() payload shape", { tags: ["compliance"] }, () => {
	it("publishes { text, sender } only — no messages array", () => {
		const { n } = makeNerve();
		const organ = new DialogOrgan({ sink: () => {} });
		organ.mount(n);

		const captured: unknown[] = [];
		n.sense.subscribe("llm.input", (e) => {
			captured.push(e.payload);
		});

		organ.receive("hello");

		expect(captured).toHaveLength(1);
		const p = captured[0] as Record<string, unknown>;
		expect(p.text).toBe("hello");
		expect(p.sender).toBe("human");
		expect(p.messages).toBeUndefined();
		expect(p.tools).toBeUndefined();
	});
});
