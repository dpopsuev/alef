import { describe, expect, it } from "vitest";
import { type EventMessage, newCorrelationId } from "../src/messages.js";
import { InProcessBus } from "../src/in-process-bus.js";

describe("dead letter detection", { tags: ["unit"] }, () => {
	it("publishes error event when no specific handler is registered", async () => {
		const bus = new InProcessBus();
		const received: EventMessage[] = [];
		bus.subscribe("event", "fs.read", (e) => void received.push(e));

		bus.publish("command", { type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(received).toHaveLength(1);
		expect(received[0].isError).toBe(true);
		expect(received[0].errorMessage).toMatch(/no adapter handles command\/fs\.read/);
	});

	it("does not dead-letter when a specific handler is registered", async () => {
		const bus = new InProcessBus();
		const deadLetters: EventMessage[] = [];
		bus.subscribe("event", "fs.read", (e) => void deadLetters.push(e));
		// Register specific handler
		bus.asBus().command.subscribe("fs.read", () => {});

		bus.publish("command", { type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(deadLetters).toHaveLength(0);
	});

	it("mirrors toolCallId on the dead letter event message", async () => {
		const bus = new InProcessBus();
		const received: EventMessage[] = [];
		bus.subscribe("event", "shell.exec", (e) => void received.push(e));

		bus.publish("command", {
			type: "shell.exec",
			payload: { command: "echo hi", toolCallId: "tc-42" },
			correlationId: newCorrelationId(),
		});
		await Promise.resolve();

		expect(received[0].isError).toBe(true);
		expect(received[0].payload.toolCallId).toBe("tc-42");
	});

	it("wildcard subscribers do not prevent dead letter", async () => {
		const bus = new InProcessBus();
		const allCommands: unknown[] = [];
		const deadLetters: EventMessage[] = [];
		bus.onAny("command", (e) => allCommands.push(e));
		bus.subscribe("event", "code.read", (e) => void deadLetters.push(e));

		bus.publish("command", { type: "code.read", payload: {}, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(allCommands).toHaveLength(1); // wildcard still sees it
		expect(deadLetters[0].isError).toBe(true);
	});

	it("dead letter preserves correlationId", async () => {
		const bus = new InProcessBus();
		const corr = newCorrelationId();
		let gotCorr = "";
		bus.subscribe("event", "web.fetch", (e) => {
			gotCorr = e.correlationId;
		});

		bus.publish("command", { type: "web.fetch", payload: { url: "https://example.com" }, correlationId: corr });
		await Promise.resolve();

		expect(gotCorr).toBe(corr);
	});
});
