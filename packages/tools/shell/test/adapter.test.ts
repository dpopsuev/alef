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

	it("preserves diagnostic stdout/stderr on non-zero exit in the final error event", async () => {
		const f = fixture();
		const diagnostic = "error TS2339: Property input does not exist on type CommandHandlerCtx";
		const final = await f.callStreaming(
			"shell.exec",
			{ command: `printf '%s\\n' ${JSON.stringify(diagnostic)} >&2; exit 1` },
			{ timeoutMs: 10_000 },
		);
		expect(final.isError).toBe(true);
		expect(final.errorMessage).toContain(diagnostic);
		expect(String(final.payload.output ?? "")).toContain(diagnostic);
		expect(final.payload.exitCode).toBe(1);
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

describe("ShellAdapter — timeout kills hung grandchildren", { tags: ["compliance"] }, () => {
	it("timeout:1 ends a silent sleep before the 300s outer default", async () => {
		const f = fixture();
		const started = Date.now();
		// sleep with no stdout — same silence pattern as hung tsc
		const final = await f.callStreaming("shell.exec", {
			command: "sleep 120",
			timeout: 1,
		});
		const elapsedMs = Date.now() - started;
		expect(final.isError).toBe(true);
		expect(final.errorMessage ?? "").toMatch(/timed out/i);
		expect(elapsedMs).toBeLessThan(15_000);
		f.dispose();
	});
});

describe("ShellAdapter — heartbeat supervision", { tags: ["compliance"] }, () => {
	it("emits heartbeats for quiet but healthy commands and still succeeds", async () => {
		const f = fixture();
		const partials: Array<Record<string, unknown>> = [];
		f.bus.asBus().event.subscribe("shell.exec", (event) => {
			if (event.payload.isFinal === false) partials.push(event.payload as Record<string, unknown>);
		});

		const final = await f.callStreaming("shell.exec", {
			command: "sleep 6; echo done",
			timeout: 15,
		});

		expect(final.isError).toBe(false);
		expect(String(final.payload.output ?? "")).toContain("done");
		expect(String(final.payload.output ?? "")).not.toContain("__alefHeartbeat");
		expect(
			partials.some((payload) => typeof payload.classification === "string" && payload.classification.includes("cpu")),
		).toBe(true);
		f.dispose();
	}, 20_000);
});
