import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createShellOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve(), cerebrum: nerve.asNerve() };
}

function publishMotor(
	nerve: InProcessNerve,
	type: string,
	payload: Record<string, unknown>,
	correlationId = "test-corr",
) {
	nerve.asNerve().motor.publish({ type, correlationId, timestamp: Date.now(), payload });
}

/** Collect Sense events until isFinal: true, return the final event. */
function waitForFinalSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const unsub = nerve.asNerve().sense.subscribe(type, (event) => {
			if ((event.payload as { isFinal?: boolean }).isFinal || event.isError) {
				unsub();
				resolve(event);
			}
		});
	});
}

describe("ShellCorpusOrgan", () => {
	it("has name=shell, name=shell, and 1 tool", () => {
		const organ = createShellOrgan({ cwd: process.cwd() });
		expect(organ.name).toBe("shell");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0].name).toBe("shell.exec");
	});

	it("unmount unsubscribes motor handler", () => {
		const { nerve } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());
		expect(nerve.listenerCount("motor", "shell.exec")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "shell.exec")).toBe(0);
	});

	it("executes a command and streams Sense/shell.exec, final has output", async () => {
		const { nerve } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const finalP = waitForFinalSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "echo hello" });
		const final = await finalP;

		expect(final.isError).toBe(false);
		expect(final.payload.isFinal).toBe(true);
		const output = String(final.payload.output ?? "");
		expect(output).toContain("hello");
		unmount();
	});

	it("mirrors correlationId across all streaming events", async () => {
		const { nerve } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());
		const correlationId = "corr-stream";

		const finalP = waitForFinalSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "echo test" }, correlationId);
		const final = await finalP;

		expect(final.correlationId).toBe(correlationId);
		unmount();
	});

	it("reports non-zero exit code as isError on final event", async () => {
		const { nerve } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const finalP = waitForFinalSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "exit 1" });
		const final = await finalP;

		expect(final.isError).toBe(true);
		unmount();
	});

	it("applies commandPrefix", async () => {
		const { nerve } = makeNerve();
		const organ = createShellOrgan({ cwd: process.cwd(), commandPrefix: "export MYVAR=prefixed" });
		const unmount = organ.mount(nerve.asNerve());

		const finalP = waitForFinalSense(nerve, "shell.exec");
		publishMotor(nerve, "shell.exec", { command: "echo $MYVAR" });
		const final = await finalP;

		expect(final.isError).toBe(false);
		const output = String(final.payload.output ?? "");
		expect(output).toContain("prefixed");
		unmount();
	});
});
