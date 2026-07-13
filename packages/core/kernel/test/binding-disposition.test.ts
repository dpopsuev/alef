import { describe, expect, it } from "vitest";
import type { Binding } from "../src/bus/binding.js";
import { withBindings } from "../src/bus/binding.js";
import { InProcessBus } from "../src/bus/in-process-bus.js";
import { newCorrelationId } from "../src/bus/messages.js";

describe("withBindings dispositions", { tags: ["unit"] }, () => {
	it("forwards the original command when the chain approves", async () => {
		const root = new InProcessBus();
		const base = root.asBus();
		const forwarded: string[] = [];
		base.command.subscribe("fs.write", (event) => {
			forwarded.push(String(event.payload.path ?? ""));
		});
		base.command.subscribe("validate.required", (event) => {
			const id = (event.payload as { id: string }).id;
			base.event.publish({
				type: "validate.result",
				correlationId: event.correlationId,
				isError: false,
				payload: { id, approved: true, reviewer: "gate" },
			});
		});

		const bindings = new Map<string, Binding>([
			[
				"gate",
				{
					id: "gate",
					event: "fs.write",
					mode: "ordered",
					chain: [{ adapter: "gate", timeout: 1_000 }],
				},
			],
		]);
		const wrapped = withBindings(bindings, base);
		wrapped.command.publish({
			type: "fs.write",
			payload: { path: "a.ts", toolCallId: "tc-1" },
			correlationId: newCorrelationId(),
		});
		await viWait();
		expect(forwarded).toEqual(["a.ts"]);
	});

	it("publishes an error event when a stage times out (no auto-approve)", async () => {
		const root = new InProcessBus();
		const base = root.asBus();
		const errors: Array<{ message?: string; toolCallId?: string }> = [];
		base.event.subscribe("fs.write", (event) => {
			errors.push({
				message: event.errorMessage,
				toolCallId: typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined,
			});
		});
		const bindings = new Map<string, Binding>([
			[
				"gate",
				{
					id: "gate",
					event: "fs.write",
					mode: "ordered",
					chain: [{ adapter: "silent", timeout: 20 }],
				},
			],
		]);
		const wrapped = withBindings(bindings, base);
		wrapped.command.publish({
			type: "fs.write",
			payload: { path: "a.ts", toolCallId: "tc-timeout" },
			correlationId: newCorrelationId(),
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(errors).toHaveLength(1);
		expect(errors[0]!.toolCallId).toBe("tc-timeout");
		expect(errors[0]!.message).toMatch(/timed out/i);
	});
});

function viWait(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}
