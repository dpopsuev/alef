/**
 * Tests for InProcessOrganBus — the EDA routing contract.
 *
 * These tests verify that:
 *   - A mounted organ receives invocations via the bus
 *   - invoke emits organ.invoke.v1 and organ.result.v1 audit events
 *   - An unmounted organ produces a typed error (not a silent bypass)
 *   - Unmounting a handler removes it cleanly
 */

import type { BusOrgan as Organ, OrganBus } from "@dpopsuev/alef-spine";
import { InProcessOrganBus, MemLog } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog() {
	return new MemLog();
}

function makeGrepOrgan(): Organ {
	return {
		name: "fs",
		actions: ["grep", "find", "ls"],
		mount(bus: OrganBus): () => void {
			return bus.handle("fs", async (action, args) => {
				if (action === "grep") {
					const pattern = String(args.pattern ?? "");
					return { ok: true, content: `grep:${pattern}`, contentLength: pattern.length + 5 };
				}
				if (action === "find") {
					return { ok: true, content: "find:result", contentLength: 11 };
				}
				return { ok: false, content: null, contentLength: 0, error: `Unknown action: ${action}` };
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InProcessOrganBus", () => {
	it("routes invoke to mounted handler and returns result", async () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		const organ = makeGrepOrgan();
		const unmount = organ.mount(bus);

		const result = await bus.invoke("fs", "grep", { pattern: "hello" });

		expect(result.ok).toBe(true);
		expect(result.content).toBe("grep:hello");
		expect(result.contentLength).toBeGreaterThan(0);

		unmount();
	});

	it("emits organ.invoke.v1 and organ.result.v1 audit events", async () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		const organ = makeGrepOrgan();
		const unmount = organ.mount(bus);

		await bus.invoke("fs", "grep", { pattern: "world" });

		const invokeEvents = log.since(0).filter((e) => e.kind === "organ.invoke.v1");
		const resultEvents = log.since(0).filter((e) => e.kind === "organ.result.v1");

		expect(invokeEvents).toHaveLength(1);
		expect(resultEvents).toHaveLength(1);

		const invokeData = invokeEvents[0].data as { organ: string; action: string; gate: string; correlationId: string };
		expect(invokeData.organ).toBe("fs");
		expect(invokeData.action).toBe("grep");
		expect(invokeData.gate).toBe("requested");

		const resultData = resultEvents[0].data as {
			organ: string;
			action: string;
			status: string;
			correlationId: string;
		};
		expect(resultData.organ).toBe("fs");
		expect(resultData.action).toBe("grep");
		expect(resultData.status).toBe("ok");
		expect(resultData.correlationId).toBe(invokeData.correlationId);

		unmount();
	});

	it("throws a typed error when organ is not mounted", async () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		await expect(bus.invoke("shell", "run", { cmd: "ls" })).rejects.toThrow(/Organ not mounted: "shell"/);
	});

	it("isMounted returns correct state before and after mount", () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		expect(bus.isMounted("fs")).toBe(false);
		const unmount = makeGrepOrgan().mount(bus);
		expect(bus.isMounted("fs")).toBe(true);
		unmount();
		expect(bus.isMounted("fs")).toBe(false);
	});

	it("mountedOrgans lists all currently mounted organs", () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		expect(bus.mountedOrgans()).toEqual([]);
		const unmount = makeGrepOrgan().mount(bus);
		expect(bus.mountedOrgans()).toContain("fs");
		unmount();
		expect(bus.mountedOrgans()).toEqual([]);
	});

	it("handler error is captured and returned as ok:false result", async () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		bus.handle("bad-organ", async () => {
			throw new Error("organ exploded");
		});

		const result = await bus.invoke("bad-organ", "explode", {});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/organ exploded/);

		// Still emits result event with error gate
		const resultEvents = log.since(0).filter((e) => e.kind === "organ.result.v1");
		expect(resultEvents).toHaveLength(1);
		const rd = resultEvents[0].data as { gate: string; status: string };
		expect(rd.gate).toBe("error");
		expect(rd.status).toBe("error");
	});

	it("correlationId is consistent between invoke and result events", async () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);

		makeGrepOrgan().mount(bus);
		await bus.invoke("fs", "find", {});

		const all = log.since(0);
		const invoke = all.find((e) => e.kind === "organ.invoke.v1")!;
		const result = all.find((e) => e.kind === "organ.result.v1")!;

		const invData = invoke.data as { correlationId: string };
		const resData = result.data as { correlationId: string };
		expect(invData.correlationId).toBe(resData.correlationId);
	});

	it("Organ interface: mount returns an unmount function", () => {
		const log = makeLog();
		const bus = new InProcessOrganBus(log);
		const organ = makeGrepOrgan();

		const unmount = organ.mount(bus);
		expect(typeof unmount).toBe("function");
		expect(bus.isMounted("fs")).toBe(true);
		unmount();
		expect(bus.isMounted("fs")).toBe(false);
	});
});
