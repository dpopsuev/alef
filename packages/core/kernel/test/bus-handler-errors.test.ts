import { describe, expect, it, vi } from "vitest";
import { newCorrelationId } from "../src/bus/messages.js";
import { InProcessBus } from "../src/bus/in-process-bus.js";

describe("InProcessBus handler errors", { tags: ["unit"] }, () => {
	it("reports sync handler throws via onHandlerError", () => {
		const errors: Array<{ channel: string; type: string; error: unknown }> = [];
		const bus = new InProcessBus({
			onHandlerError: (info) => {
				errors.push(info);
			},
		});
		bus.subscribe("command", "fs.read", () => {
			throw new Error("boom-sync");
		});
		bus.publish("command", { type: "fs.read", payload: {}, correlationId: newCorrelationId() });
		expect(errors).toHaveLength(1);
		expect(errors[0]!.type).toBe("fs.read");
		expect(String(errors[0]!.error)).toMatch(/boom-sync/);
	});

	it("reports async handler rejections via onHandlerError", async () => {
		const errors: Array<{ channel: string; type: string; error: unknown }> = [];
		const bus = new InProcessBus({
			onHandlerError: (info) => {
				errors.push(info);
			},
		});
		bus.subscribe("event", "fs.read", async () => {
			throw new Error("boom-async");
		});
		bus.publish("event", {
			type: "fs.read",
			payload: {},
			correlationId: newCorrelationId(),
			isError: false,
		});
		await vi.waitFor(() => {
			expect(errors).toHaveLength(1);
		});
		expect(String(errors[0]!.error)).toMatch(/boom-async/);
	});
});
