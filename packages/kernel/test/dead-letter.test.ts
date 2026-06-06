import { describe, expect, it } from "vitest";
import type { SenseEvent } from "../src/buses.js";
import { InProcessNerve, newCorrelationId } from "../src/buses.js";

describe("dead letter detection", { tags: ["unit"] }, () => {
	it("publishes error sense when no specific handler is registered", async () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.subscribeSense("fs.read", (e) => void received.push(e));

		nerve.publishMotor({ type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(received).toHaveLength(1);
		expect(received[0].isError).toBe(true);
		expect(received[0].errorMessage).toMatch(/no organ handles motor\/fs\.read/);
	});

	it("does not dead-letter when a specific handler is registered", async () => {
		const nerve = new InProcessNerve();
		const deadLetters: SenseEvent[] = [];
		nerve.subscribeSense("fs.read", (e) => void deadLetters.push(e));
		// Register specific handler
		nerve.asNerve().motor.subscribe("fs.read", () => {});

		nerve.publishMotor({ type: "fs.read", payload: { path: "x.ts" }, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(deadLetters).toHaveLength(0);
	});

	it("mirrors toolCallId on the dead letter sense event", async () => {
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.subscribeSense("shell.exec", (e) => void received.push(e));

		nerve.publishMotor({
			type: "shell.exec",
			payload: { command: "echo hi", toolCallId: "tc-42" },
			correlationId: newCorrelationId(),
		});
		await Promise.resolve();

		expect(received[0].isError).toBe(true);
		expect(received[0].payload.toolCallId).toBe("tc-42");
	});

	it("wildcard subscribers do not prevent dead letter", async () => {
		const nerve = new InProcessNerve();
		const allMotor: unknown[] = [];
		const deadLetters: SenseEvent[] = [];
		nerve.onAnyMotor((e) => allMotor.push(e));
		nerve.subscribeSense("lector.read", (e) => void deadLetters.push(e));

		nerve.publishMotor({ type: "lector.read", payload: {}, correlationId: newCorrelationId() });
		await Promise.resolve();

		expect(allMotor).toHaveLength(1); // wildcard still sees it
		expect(deadLetters[0].isError).toBe(true);
	});

	it("dead letter preserves correlationId", async () => {
		const nerve = new InProcessNerve();
		const corr = newCorrelationId();
		let gotCorr = "";
		nerve.subscribeSense("web.fetch", (e) => {
			gotCorr = e.correlationId;
		});

		nerve.publishMotor({ type: "web.fetch", payload: { url: "https://example.com" }, correlationId: corr });
		await Promise.resolve();

		expect(gotCorr).toBe(corr);
	});
});
