import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it, vi } from "vitest";
import { DIALOG_MESSAGE, DialogOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve(), corpus: nerve.asNerve(), cerebrum: nerve.asNerve() };
}

describe("DialogOrgan", () => {
	it("has kind=corpus, name=dialog, tool=dialog.message", () => {
		const organ = new DialogOrgan();
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

describe("DialogOrgan — history + system prompt", () => {
	it("payload.messages contains the user message on first send", () => {
		const { n } = makeNerve();
		const organ = new DialogOrgan({ sink: () => {} });
		organ.mount(n);

		const captured: unknown[] = [];
		n.sense.subscribe(DIALOG_MESSAGE, (e) => {
			captured.push(e.payload.messages);
		});

		organ.receive("hello");

		expect(captured).toHaveLength(1);
		const msgs = captured[0] as Array<{ role: string; content: string }>;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: "user", content: "hello" });
	});

	it("history accumulates across turns", async () => {
		const { n } = makeNerve();
		const organ = new DialogOrgan({ sink: () => {} });
		organ.mount(n);

		// Echo organ publishes Motor/"dialog.message" in response.
		n.sense.subscribe(DIALOG_MESSAGE, (e) => {
			n.motor.publish({
				type: DIALOG_MESSAGE,
				payload: { text: `echo: ${String((e.payload.messages as Array<{ content: string }>).at(-1)?.content)}` },
				correlationId: e.correlationId,
				timestamp: Date.now(),
			});
		});

		await organ.send("turn1");
		await organ.send("turn2");

		// After two turns, history = [user, assistant, user, assistant]
		expect(organ.messages).toHaveLength(4);
		expect(organ.messages[0]).toMatchObject({ role: "user", content: "turn1" });
		expect(organ.messages[1]).toMatchObject({ role: "assistant" });
		expect(organ.messages[2]).toMatchObject({ role: "user", content: "turn2" });
		expect(organ.messages[3]).toMatchObject({ role: "assistant" });
	});

	it("systemPrompt is prepended to messages", () => {
		const { n } = makeNerve();
		const organ = new DialogOrgan({ sink: () => {}, systemPrompt: "You are a coding assistant." });
		organ.mount(n);

		const captured: unknown[] = [];
		n.sense.subscribe(DIALOG_MESSAGE, (e) => {
			captured.push(e.payload.messages);
		});

		organ.receive("hi");

		const msgs = captured[0] as Array<{ role: string; content: string }>;
		expect(msgs[0]).toMatchObject({ role: "system", content: "You are a coding assistant." });
		expect(msgs[1]).toMatchObject({ role: "user", content: "hi" });
	});

	it("clearHistory resets messages", async () => {
		const { n } = makeNerve();
		const organ = new DialogOrgan({ sink: () => {} });
		organ.mount(n);

		n.sense.subscribe(DIALOG_MESSAGE, (e) => {
			n.motor.publish({
				type: DIALOG_MESSAGE,
				payload: { text: "ok" },
				correlationId: e.correlationId,
				timestamp: Date.now(),
			});
		});

		await organ.send("one");
		expect(organ.messages).toHaveLength(2);
		organ.clearHistory();
		expect(organ.messages).toHaveLength(0);
	});
});
