import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { dispatchTools } from "../src/tool-dispatch.js";

describe("dispatchTools — waiter before publish", { tags: ["unit"] }, () => {
	it("resolves when a sync command handler publishes the result immediately", async () => {
		const handlers = new Map<string, Array<(event: EventMessage) => void>>();
		const event = {
			subscribe: (type: string, handler: (event: EventMessage) => void) => {
				const set = handlers.get(type) ?? [];
				set.push(handler);
				handlers.set(type, set);
				return () => {
					handlers.set(
						type,
						(handlers.get(type) ?? []).filter((h) => h !== handler),
					);
				};
			},
		};
		const command = {
			publish: (msg: { type: string; payload: Record<string, unknown>; correlationId: string }) => {
				for (const handler of handlers.get(msg.type) ?? []) {
					handler({
						type: msg.type,
						correlationId: msg.correlationId,
						payload: { toolCallId: msg.payload.toolCallId, ok: true, isFinal: true },
						isError: false,
						timestamp: Date.now(),
						elapsed: 0,
					});
				}
			},
		};
		const notifications: string[] = [];
		const signal = {
			publish: (msg: { type: string }) => {
				notifications.push(msg.type);
			},
		};

		const results = await dispatchTools(
			command,
			signal,
			event,
			"corr-sync",
			[{ id: "tc-1", name: "echo", args: {} }],
			(name) => name,
			5_000,
			{},
		);

		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBeFalsy();
		expect(results[0]!.payload.ok).toBe(true);
		expect(notifications).toContain("llm.tool-start");
		expect(notifications).toContain("llm.tool-end");
	});
});
