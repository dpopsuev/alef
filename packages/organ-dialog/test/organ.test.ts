import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it, vi } from "vitest";
import { DIALOG_MESSAGE, DialogOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

describe("DialogOrgan", () => {
	it("has kind=corpus, name=dialog, tool=dialog.message", () => {
		const organ = new DialogOrgan();
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("dialog");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0].name).toBe(DIALOG_MESSAGE);
	});

	it("unmount clears the nerve ref", () => {
		const { nerve, corpus } = makeNerve();
		const organ = new DialogOrgan();
		const unmount = organ.mount(corpus);
		expect(nerve.listenerCount("motor", DIALOG_MESSAGE)).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", DIALOG_MESSAGE)).toBe(0);
		expect(() => organ.receive("hi")).toThrow("not mounted");
	});

	it('receive() publishes Sense/"dialog.message" with text and sender', () => {
		const { corpus, cerebrum } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(corpus);

		const received: unknown[] = [];
		cerebrum.sense.subscribe(DIALOG_MESSAGE, (e) => {
			received.push(e);
		});

		organ.receive("hello", "human");

		expect(received).toHaveLength(1);
		const event = received[0] as { payload: { text: string; sender: string } };
		expect(event.payload.text).toBe("hello");
		expect(event.payload.sender).toBe("human");
	});

	it("receive() defaults sender to 'human'", () => {
		const { corpus, cerebrum } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(corpus);

		const received: unknown[] = [];
		cerebrum.sense.subscribe(DIALOG_MESSAGE, (e) => {
			received.push(e);
		});
		organ.receive("test");

		const event = received[0] as { payload: { sender: string } };
		expect(event.payload.sender).toBe("human");
	});

	it("receive() accepts any sender — human, agent, system", () => {
		const { corpus, cerebrum } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(corpus);

		const senders: string[] = [];
		cerebrum.sense.subscribe(DIALOG_MESSAGE, (e) => {
			senders.push((e.payload as { sender: string }).sender);
		});

		organ.receive("ping", "human");
		organ.receive("forward", "agent:planner");
		organ.receive("boot", "system");

		expect(senders).toEqual(["human", "agent:planner", "system"]);
	});

	it('Motor/"dialog.message" from LLM routes to sink', () => {
		const sink = vi.fn();
		const { corpus, cerebrum } = makeNerve();
		const organ = new DialogOrgan({ sink });
		organ.mount(corpus);

		cerebrum.motor.publish({
			type: DIALOG_MESSAGE,
			payload: { text: "done", sender: "agent" },
			correlationId: "c1",
			timestamp: Date.now(),
		});

		expect(sink).toHaveBeenCalledWith("done", "agent");
	});

	it("sender() returns correlationId for correlation", () => {
		const { corpus, cerebrum } = makeNerve();
		const organ = new DialogOrgan();
		organ.mount(corpus);

		const ids: string[] = [];
		cerebrum.sense.subscribe(DIALOG_MESSAGE, (e) => {
			ids.push(e.correlationId);
		});

		const s = organ.sender("human");
		const id = s.send("hello");

		expect(ids).toHaveLength(1);
		expect(ids[0]).toBe(id);
	});
});
