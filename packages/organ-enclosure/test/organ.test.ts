import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createEnclosureOrgan } from "../src/organ.js";
import { StubSpace } from "../src/space.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asCerebrumNerve().motor.publish({
		type,
		payload: { ...payload, toolCallId: `tc-${Math.random().toString(36).slice(2)}` },
		correlationId: "test-corr",
		timestamp: Date.now(),
	});
}

function waitSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asCerebrumNerve().sense.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EnclosureOrgan", () => {
	it("has kind=corpus, name=enclosure, and 8 tools", () => {
		const organ = createEnclosureOrgan({ stub: true });
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("enclosure");
		expect(organ.tools).toHaveLength(8);
		expect(organ.tools.map((t) => t.name)).toEqual([
			"enclosure.create",
			"enclosure.diff",
			"enclosure.commit",
			"enclosure.reset",
			"enclosure.snapshot",
			"enclosure.restore",
			"enclosure.exec",
			"enclosure.destroy",
		]);
	});

	it("unmount cleans up all motor subscriptions", () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);
		expect(nerve.listenerCount("motor", "enclosure.create")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "enclosure.create")).toBe(0);
	});

	describe("create → diff → commit → destroy lifecycle", () => {
		it("create returns spaceId and workDir", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const p = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/test-ws" });
			const result = await p;

			expect(result.isError).toBe(false);
			expect(typeof result.payload.spaceId).toBe("string");
			expect(result.payload.workDir).toBe("/tmp/test-ws");
			unmount();
		});

		it("diff returns empty changes on fresh space", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const createP = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/ws" });
			const created = await createP;
			const spaceId = created.payload.spaceId as string;

			const diffP = waitSense(nerve, "enclosure.diff");
			publishMotor(nerve, "enclosure.diff", { spaceId });
			const diff = await diffP;

			expect(diff.isError).toBe(false);
			expect(diff.payload.changes).toEqual([]);
			unmount();
		});

		it("reset clears changes", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const createP = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/ws" });
			const created = await createP;
			const spaceId = created.payload.spaceId as string;

			const resetP = waitSense(nerve, "enclosure.reset");
			publishMotor(nerve, "enclosure.reset", { spaceId });
			const reset = await resetP;

			expect(reset.isError).toBe(false);
			expect(reset.payload.ok).toBe(true);
			unmount();
		});

		it("snapshot and restore round-trip", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const createP = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/ws" });
			const created = await createP;
			const spaceId = created.payload.spaceId as string;

			const snapP = waitSense(nerve, "enclosure.snapshot");
			publishMotor(nerve, "enclosure.snapshot", { spaceId, name: "before-edit" });
			const snap = await snapP;
			expect(snap.isError).toBe(false);

			const restP = waitSense(nerve, "enclosure.restore");
			publishMotor(nerve, "enclosure.restore", { spaceId, name: "before-edit" });
			const rest = await restP;
			expect(rest.isError).toBe(false);
			expect(rest.payload.name).toBe("before-edit");

			unmount();
		});

		it("exec returns output from stub", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const createP = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/ws" });
			const created = await createP;
			const spaceId = created.payload.spaceId as string;

			const execP = waitSense(nerve, "enclosure.exec");
			publishMotor(nerve, "enclosure.exec", { spaceId, command: ["echo", "hello"] });
			const result = await execP;

			expect(result.isError).toBe(false);
			expect(result.payload.exitCode).toBe(0);
			expect(result.payload.output).toContain("echo hello");
			unmount();
		});

		it("destroy removes the space from registry", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const createP = waitSense(nerve, "enclosure.create");
			publishMotor(nerve, "enclosure.create", { workspace: "/tmp/ws" });
			const created = await createP;
			const spaceId = created.payload.spaceId as string;

			const destroyP = waitSense(nerve, "enclosure.destroy");
			publishMotor(nerve, "enclosure.destroy", { spaceId });
			const destroyed = await destroyP;
			expect(destroyed.isError).toBe(false);

			// Second destroy on same spaceId → error
			const destroy2P = waitSense(nerve, "enclosure.destroy");
			publishMotor(nerve, "enclosure.destroy", { spaceId });
			const destroyed2 = await destroy2P;
			expect(destroyed2.isError).toBe(true);
			unmount();
		});

		it("unknown spaceId returns error", async () => {
			const { nerve, corpus } = makeNerve();
			const unmount = createEnclosureOrgan({ stub: true }).mount(corpus);

			const p = waitSense(nerve, "enclosure.diff");
			publishMotor(nerve, "enclosure.diff", { spaceId: "does-not-exist" });
			const result = await p;

			expect(result.isError).toBe(true);
			expect(result.errorMessage).toContain("unknown spaceId");
			unmount();
		});
	});

	describe("StubSpace unit", () => {
		it("injects and diffs changes", async () => {
			const space = new StubSpace("/workspace");
			space._injectChange({ path: "src/main.ts", kind: "modified", size: 1024 });
			const changes = await space.diff();
			expect(changes).toHaveLength(1);
			expect(changes[0].kind).toBe("modified");
		});

		it("commit clears changes", async () => {
			const space = new StubSpace("/workspace");
			space._injectChange({ path: "a.ts", kind: "created", size: 100 });
			await space.commit();
			expect(await space.diff()).toHaveLength(0);
		});
	});
});
