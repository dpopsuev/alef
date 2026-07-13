import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createShellAdapter } from "../src/adapter.js";

// Framework compliance — schema rejection, structural checks, streaming contract.
// shell.exec uses typedStreamAction → auto-discovered as a streaming tool.
// validPayload must be provided for each streaming tool.
adapterComplianceSuite(() => createShellAdapter({ cwd: "/tmp" }), {
	streaming: {
		"shell.exec": {
			validPayload: { command: "printf 'a%.0s' {1..200}" },
			thresholdMs: 50,
		},
	},
});

function fixture(opts: { commandPrefix?: string } = {}) {
	const f = new BusFixture();
	f.mount(createShellAdapter({ cwd: process.cwd(), ...opts }));
	return f;
}

describe("ShellAdapter", { tags: ["compliance"] }, () => {
	it("has name=shell and 1 tool", () => {
		const adapter = createShellAdapter({ cwd: process.cwd() });
		expect(adapter.name).toBe("shell");
		expect(adapter.tools).toHaveLength(1);
		expect(adapter.tools[0]!.name).toBe("shell.exec");
	});

	it("unmount unsubscribes command handler", () => {
		const f = new BusFixture();
		const adapter = createShellAdapter({ cwd: process.cwd() });
		const unmount = f.mount(adapter);
		expect(f.bus.listenerCount("command", "shell.exec")).toBe(1);
		unmount();
		expect(f.bus.listenerCount("command", "shell.exec")).toBe(0);
	});

	it("executes a command and streams Event/shell.exec, final has output", async () => {
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

describe("ShellAdapter — COLUMNS injection", { tags: ["compliance"] }, () => {
	it("COLUMNS is set to 220 in spawned command environment", async () => {
		const f = fixture();
		const result = await f.callStreaming("shell.exec", { command: "echo COLS=$COLUMNS" });
		expect(result.isError).toBe(false);
		expect((result.payload as { output?: string }).output ?? "").toContain("COLS=220");
		f.dispose();
	});
});
