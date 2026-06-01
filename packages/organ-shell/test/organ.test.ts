import { NerveFixture } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createShellOrgan } from "../src/organ.js";

function fixture(opts: { commandPrefix?: string } = {}) {
	const f = new NerveFixture();
	f.mount(createShellOrgan({ cwd: process.cwd(), ...opts }));
	return f;
}

describe("ShellCorpusOrgan", () => {
	it("has name=shell and 1 tool", () => {
		const organ = createShellOrgan({ cwd: process.cwd() });
		expect(organ.name).toBe("shell");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0].name).toBe("shell.exec");
	});

	it("unmount unsubscribes motor handler", () => {
		const f = new NerveFixture();
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = f.mount(organ);
		expect(f.nerve.listenerCount("motor", "shell.exec")).toBe(1);
		unmount();
		expect(f.nerve.listenerCount("motor", "shell.exec")).toBe(0);
	});

	it("executes a command and streams Sense/shell.exec, final has output", async () => {
		const f = fixture();
		const final = await f.callStreaming("shell.exec", { command: "echo hello" });
		expect(final.isError).toBe(false);
		expect(final.payload.isFinal).toBe(true);
		expect(String(final.payload.output ?? "")).toContain("hello");
		f.dispose();
	});

	it("mirrors correlationId across all streaming events", async () => {
		const f = fixture();
		const correlationId = "corr-stream";
		const final = await f.callStreaming("shell.exec", { command: "echo test" }, { correlationId });
		expect(final.correlationId).toBe(correlationId);
		f.dispose();
	});

	it("reports non-zero exit code as isError on final event", async () => {
		const f = fixture();
		const final = await f.callStreaming("shell.exec", { command: "exit 1" });
		expect(final.isError).toBe(true);
		f.dispose();
	});

	it("applies commandPrefix", async () => {
		const f = fixture({ commandPrefix: "export MYVAR=prefixed" });
		const final = await f.callStreaming("shell.exec", { command: "echo $MYVAR" });
		expect(final.isError).toBe(false);
		expect(String(final.payload.output ?? "")).toContain("prefixed");
		f.dispose();
	});
});

describe("ShellCorpusOrgan — COLUMNS injection", () => {
	it("COLUMNS is set to 220 in spawned command environment", async () => {
		const f = fixture();
		const result = await f.callStreaming("shell.exec", { command: "echo COLS=$COLUMNS" });
		expect(result.isError).toBe(false);
		expect((result.payload as { output?: string }).output ?? "").toContain("COLS=220");
		f.dispose();
	});
});
