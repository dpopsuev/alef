import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createShellOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asCerebrumNerve().motor.publish({
		type,
		correlationId: `test-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		payload,
	});
}

function waitForSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const unsub = nerve.asCerebrumNerve().sense.subscribe(type, (event) => {
			unsub();
			resolve(event);
		});
	});
}

describe("ShellCorpusOrgan", () => {
	it("has kind=corpus, name=shell, and 1 tool", () => {
		const organ = createShellOrgan({ cwd: process.cwd() });
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("shell");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0].name).toBe("shell.exec");
	});

	it("unmount unsubscribes motor handler", () => {
		const { nerve, corpus } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(corpus);
		expect(nerve.listenerCount("motor", "shell.exec")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "shell.exec")).toBe(0);
	});

	it("executes a command and publishes Sense/shell.exec", async () => {
		const { nerve, corpus } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(corpus);

		const resultP = waitForSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "echo hello" });
		const result = await resultP;

		expect(result.isError).toBe(false);
		expect(result.payload.text).toContain("hello");
		expect(result.payload.exitCode).toBe(0);
		unmount();
	});

	it("mirrors correlationId from motor event", async () => {
		const { nerve, corpus } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(corpus);
		const correlationId = "corr-123";

		const resultP = waitForSense(nerve, "shell.exec");
		nerve.asCerebrumNerve().motor.publish({
			type: "shell.exec",
			correlationId,
			timestamp: Date.now(),
			payload: { command: "echo test" },
		});
		const result = await resultP;

		expect(result.correlationId).toBe(correlationId);
		unmount();
	});

	it("reports non-zero exit code as isError", async () => {
		const { nerve, corpus } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(corpus);

		const resultP = waitForSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "exit 1" });
		const result = await resultP;

		expect(result.isError).toBe(true);
		expect(result.payload.exitCode).toBe(1);
		unmount();
	});

	it("applies commandPrefix", async () => {
		const { nerve, corpus } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd(), commandPrefix: "export MYVAR=prefixed" });
		const unmount = organ.mount(corpus);

		const resultP = waitForSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "echo $MYVAR" });
		const result = await resultP;

		expect(result.isError).toBe(false);
		expect(result.payload.text).toContain("prefixed");
		unmount();
	});
});
