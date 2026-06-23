import { describe, expect, it } from "vitest";
import { type EventMessage, newCorrelationId } from "../src/buses.js";
import { InProcessBus } from "../src/in-process-bus.js";

describe("dead letter detection", { tags: ["unit"] }, () => {
	it("publishes error event when no specific handler is registered", async () => {
		const nerve = new InProcessBus();
		const received: EventMessage[] = [];
		nerve.subscribe("event", "fs.read", (e) => void received.push(e));

		nerve.publish("command", { type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(received).toHaveLength(1);
		expect(received[0].isError).toBe(true);
		expect(received[0].errorMessage).toMatch(/no adapter handles command\/fs\.read/);
	});

	it("does not dead-letter when a specific handler is registered", async () => {
		const nerve = new InProcessBus();
		const deadLetters: EventMessage[] = [];
		nerve.subscribe("event", "fs.read", (e) => void deadLetters.push(e));
		// Register specific handler
		nerve.asBus().command.subscribe("fs.read", () => {});

		nerve.publish("command", { type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(deadLetters).toHaveLength(0);
	});

	it("mirrors toolCallId on the dead letter event message", async () => {
		const nerve = new InProcessBus();
		const received: EventMessage[] = [];
		nerve.subscribe("event", "shell.exec", (e) => void received.push(e));

		nerve.publish("command", {
			type: "shell.exec",
			payload: { command: "echo hi", toolCallId: "tc-42" },
			correlationId: newCorrelationId(),
		});
		await Promise.resolve();

		expect(received[0].isError).toBe(true);
		expect(received[0].payload.toolCallId).toBe("tc-42");
	});

	it("wildcard subscribers do not prevent dead letter", async () => {
		const nerve = new InProcessBus();
		const allCommands: unknown[] = [];
		const deadLetters: EventMessage[] = [];
		nerve.onAny("command", (e) => allCommands.push(e));
		nerve.subscribe("event", "code.read", (e) => void deadLetters.push(e));

		nerve.publish("command", { type: "code.read", payload: {}, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(allCommands).toHaveLength(1); // wildcard still sees it
		expect(deadLetters[0].isError).toBe(true);
	});

	it("dead letter preserves correlationId", async () => {
		const nerve = new InProcessBus();
		const corr = newCorrelationId();
		let gotCorr = "";
		nerve.subscribe("event", "web.fetch", (e) => {
			gotCorr = e.correlationId;
		});

		nerve.publish("command", { type: "web.fetch", payload: { url: "https://example.com" }, correlationId: corr });
		await Promise.resolve();

		expect(gotCorr).toBe(corr);
	});
});
