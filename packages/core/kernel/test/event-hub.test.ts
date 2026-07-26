import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineEvent, EventHub, EventHubOverflowError } from "../src/events.js";

const ToolCompleted = defineEvent({
	type: "tool.completed",
	version: 1,
	payload: z.object({ name: z.string(), ok: z.boolean() }),
	overflow: "reject",
});

describe("EventHub", { tags: ["unit"] }, () => {
	it("publishes validated, scoped envelopes to every subscriber", async () => {
		const hub = new EventHub({ capacity: 4, concurrency: 1 });
		const first = vi.fn();
		const second = vi.fn();
		hub.subscribe(ToolCompleted, first);
		hub.subscribe(ToolCompleted, second);

		const envelope = await hub.publish(
			ToolCompleted,
			{ name: "fs.read", ok: true },
			{
				correlationId: "corr-1",
				causationId: "cause-1",
				scope: { runId: "run-1", sessionId: "session-1" },
			},
		);

		expect(envelope).toMatchObject({
			type: "tool.completed",
			version: 1,
			correlationId: "corr-1",
			causationId: "cause-1",
			scope: { runId: "run-1", sessionId: "session-1" },
			payload: { name: "fs.read", ok: true },
		});
		expect(envelope.id).toEqual(expect.any(String));
		expect(envelope.timestamp).toEqual(expect.any(Number));
		expect(first).toHaveBeenCalledWith(envelope);
		expect(second).toHaveBeenCalledWith(envelope);
	});

	it("rejects invalid event payloads", async () => {
		const hub = new EventHub({ capacity: 1, concurrency: 1 });
		await expect(hub.publish(ToolCompleted, { name: "fs.read", ok: "yes" } as never)).rejects.toThrow(
			/invalid payload/,
		);
	});

	it("rejects overflow for non-droppable facts", async () => {
		const hub = new EventHub({ capacity: 1, concurrency: 1 });
		let release: (() => void) | undefined;
		hub.subscribe(ToolCompleted, () => new Promise<void>((resolve) => (release = resolve)));
		const first = hub.publish(ToolCompleted, { name: "first", ok: true });
		await vi.waitFor(() => expect(release).toBeDefined());

		await expect(hub.publish(ToolCompleted, { name: "second", ok: true })).rejects.toBeInstanceOf(
			EventHubOverflowError,
		);
		release?.();
		await first;
	});

	it("reports subscriber failures without turning facts into request replies", async () => {
		const onHandlerError = vi.fn();
		const hub = new EventHub({ capacity: 1, concurrency: 1, onHandlerError });
		hub.subscribe(ToolCompleted, () => Promise.reject(new Error("projection failed")));

		await expect(hub.publish(ToolCompleted, { name: "fs.read", ok: true })).resolves.toBeDefined();
		expect(onHandlerError).toHaveBeenCalledWith(
			expect.objectContaining({ type: "tool.completed", error: expect.any(Error) }),
		);
	});
});
