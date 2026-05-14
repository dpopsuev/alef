/**
 * Integration test: ShellOrgan mounted to InProcessOrganBus.
 *
 * Verifies:
 *   - exec action runs a command and returns output
 *   - organ.invoke.v1 and organ.result.v1 audit events emitted
 *   - failed command returns ok=false with exit code in error
 *   - unknown action returns ok=false
 *   - unmount removes the handler
 */

import { InProcessOrganBus, MemLog } from "@dpopsuev/alef-nerve";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import { describe, expect, it } from "vitest";

describe("ShellOrgan via OrganBus", () => {
	it("exec runs a command and returns stdout", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("shell", "exec", { command: "echo hello" });

		expect(result.ok).toBe(true);
		expect(JSON.stringify(result.content)).toMatch(/hello/);
		expect(result.contentLength).toBeGreaterThan(0);

		unmount();
	});

	it("emits invoke and result audit events", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(bus);

		await bus.invoke("shell", "exec", { command: "echo audit" });

		const invokes = log.since(0).filter((e) => e.kind === "organ.invoke.v1");
		const results = log.since(0).filter((e) => e.kind === "organ.result.v1");
		expect(invokes).toHaveLength(1);
		expect(results).toHaveLength(1);

		const inv = invokes[0].data as { organ: string; action: string };
		expect(inv.organ).toBe("shell");
		expect(inv.action).toBe("exec");

		unmount();
	});

	it("failed command returns ok=false", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("shell", "exec", { command: "exit 1" });

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Exit code/);

		unmount();
	});

	it("unknown action returns ok=false", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("shell", "unknown", {});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/unknown action/);

		unmount();
	});

	it("organ metadata is correct", () => {
		const organ = createShellOrgan({ cwd: process.cwd() });
		expect(organ.name).toBe("shell");
		expect(organ.actions).toContain("exec");
	});

	it("after unmount, invoke throws organ-not-mounted error", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createShellOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(bus);
		unmount();

		await expect(bus.invoke("shell", "exec", { command: "echo x" })).rejects.toThrow(/Organ not mounted/);
	});
});
