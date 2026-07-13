import { describe, expect, it } from "vitest";
import { deliveryFromPayload, PendingMessageQueue, totalQueueLength } from "../src/message-queue.js";

describe("PendingMessageQueue", { tags: ["unit"] }, () => {
	it("one-at-a-time drains a single item", () => {
		const queue = new PendingMessageQueue("one-at-a-time");
		queue.enqueue({ payload: { text: "a" }, correlationId: "1" });
		queue.enqueue({ payload: { text: "b" }, correlationId: "2" });
		expect(queue.drain().map((i) => i.payload.text)).toEqual(["a"]);
		expect(queue.length).toBe(1);
	});

	it("all drains every item", () => {
		const queue = new PendingMessageQueue("all");
		queue.enqueue({ payload: { text: "a" }, correlationId: "1" });
		queue.enqueue({ payload: { text: "b" }, correlationId: "2" });
		expect(queue.drain().map((i) => i.payload.text)).toEqual(["a", "b"]);
		expect(queue.length).toBe(0);
	});

	it("clear empties and returns items", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue({ payload: { text: "a" }, correlationId: "1" });
		expect(queue.clear().map((i) => i.payload.text)).toEqual(["a"]);
		expect(queue.hasItems()).toBe(false);
	});

	it("deliveryFromPayload defaults mid-turn to steer", () => {
		expect(deliveryFromPayload({}, true)).toBe("steer");
		expect(deliveryFromPayload({}, false)).toBe("followUp");
		expect(deliveryFromPayload({ delivery: "nextTurn" }, true)).toBe("nextTurn");
	});

	it("totalQueueLength sums queues", () => {
		const a = new PendingMessageQueue();
		const b = new PendingMessageQueue();
		a.enqueue({ payload: {}, correlationId: "1" });
		b.enqueue({ payload: {}, correlationId: "2" });
		b.enqueue({ payload: {}, correlationId: "3" });
		expect(totalQueueLength(a, b)).toBe(3);
	});

	it("peek returns retained items without draining", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue({ payload: { text: "a" }, correlationId: "1" });
		expect(queue.peek().map((i) => i.payload.text)).toEqual(["a"]);
		expect(queue.length).toBe(1);
	});

	it("rejects enqueue past capacity unless forced", () => {
		const queue = new PendingMessageQueue("one-at-a-time", 1);
		expect(queue.enqueue({ payload: { text: "a" }, correlationId: "1" })).toEqual({ ok: true });
		expect(queue.enqueue({ payload: { text: "b" }, correlationId: "2" })).toEqual({
			ok: false,
			reason: "capacity",
		});
		expect(queue.enqueue({ payload: { text: "c" }, correlationId: "3" }, { force: true })).toEqual({ ok: true });
		expect(queue.length).toBe(2);
	});
});
