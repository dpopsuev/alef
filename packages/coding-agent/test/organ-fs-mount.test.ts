/**
 * Integration test: FsOrgan mounted to InProcessOrganBus.
 *
 * Verifies that:
 *   - grep/find/ls are routed through the bus end-to-end
 *   - organ.invoke.v1 and organ.result.v1 audit events are emitted
 *   - an unknown action returns ok:false without crashing
 *   - the organ is cleanly removed after unmount
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessOrganBus, MemLog } from "@dpopsuev/alef-nerve";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixture: a temporary directory with known files
// ---------------------------------------------------------------------------

let fixtureDir: string;

beforeAll(() => {
	fixtureDir = join(tmpdir(), `alef-fs-organ-test-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(join(fixtureDir, "alpha.ts"), "// TODO: fix this\nconst x = 1;\n");
	writeFileSync(join(fixtureDir, "beta.ts"), "// DONE\nconst y = 2;\n");
	writeFileSync(join(fixtureDir, "gamma.md"), "# Title\nSome text here.\n");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsOrgan via OrganBus", () => {
	it("grep routes through bus and returns content", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("fs", "grep", { pattern: "TODO" });

		expect(result.ok).toBe(true);
		expect(JSON.stringify(result.content)).toMatch(/TODO/);
		expect(result.contentLength).toBeGreaterThan(0);

		unmount();
	});

	it("find routes through bus and returns file list", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("fs", "find", { pattern: "*.ts" });

		expect(result.ok).toBe(true);
		const content = JSON.stringify(result.content);
		expect(content).toMatch(/alpha\.ts|beta\.ts/);

		unmount();
	});

	it("ls routes through bus and returns directory listing", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("fs", "ls", { path: "." });

		expect(result.ok).toBe(true);
		const content = JSON.stringify(result.content);
		expect(content).toMatch(/alpha|beta|gamma/);

		unmount();
	});

	it("emits invoke + result audit events for each action", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		await bus.invoke("fs", "grep", { pattern: "DONE" });

		const invokeEvents = log.since(0).filter((e) => e.kind === "organ.invoke.v1");
		const resultEvents = log.since(0).filter((e) => e.kind === "organ.result.v1");
		expect(invokeEvents).toHaveLength(1);
		expect(resultEvents).toHaveLength(1);

		const invData = invokeEvents[0].data as { organ: string; action: string; correlationId: string };
		const resData = resultEvents[0].data as { organ: string; action: string; correlationId: string; status: string };
		expect(invData.organ).toBe("fs");
		expect(invData.action).toBe("grep");
		expect(resData.organ).toBe("fs");
		expect(resData.status).toBe("ok");
		expect(invData.correlationId).toBe(resData.correlationId);

		unmount();
	});

	it("unknown action returns ok:false", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		const result = await bus.invoke("fs", "rm_rf", {});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/unknown action/i);

		unmount();
	});

	it("after unmount, invoke throws organ-not-mounted error", async () => {
		const log = new MemLog();
		const bus = new InProcessOrganBus(log);
		const organ = createFsOrgan({ cwd: fixtureDir });
		const unmount = organ.mount(bus);

		expect(bus.isMounted("fs")).toBe(true);
		unmount();
		expect(bus.isMounted("fs")).toBe(false);

		await expect(bus.invoke("fs", "grep", { pattern: "x" })).rejects.toThrow(/Organ not mounted/);
	});

	it("organ metadata is correct", () => {
		const organ = createFsOrgan({ cwd: fixtureDir });
		expect(organ.name).toBe("fs");
		expect(organ.actions).toContain("grep");
		expect(organ.actions).toContain("find");
		expect(organ.actions).toContain("ls");
	});
});
