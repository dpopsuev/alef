import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createEnclosureAdapter } from "../src/adapter.js";
import { StubSpace } from "../src/space.js";

adapterComplianceSuite(() => createEnclosureAdapter({ stub: true }));

function fixture() {
	const f = new BusFixture();
	f.mount(createEnclosureAdapter({ stub: true }));
	return f;
}

describe("EnclosureAdapter", { tags: ["compliance"] }, () => {
	it("has name=enclosure and 8 tools", () => {
		const organ = createEnclosureAdapter({ stub: true });
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
		const f = new BusFixture();
		const unmount = f.mount(createEnclosureAdapter({ stub: true }));
		expect(f.bus.listenerCount("command", "enclosure.create")).toBe(1);
		unmount();
		expect(f.bus.listenerCount("command", "enclosure.create")).toBe(0);
	});

	describe("create → diff → commit → destroy lifecycle", () => {
		it("create returns spaceId and workDir", async () => {
			const f = fixture();
			const result = await f.call("enclosure.create", { workspace: "/tmp/test-ws" });
			expect(result.isError).toBe(false);
			expect(typeof result.payload.spaceId).toBe("string");
			expect(result.payload.workDir).toBe("/tmp/test-ws");
			f.dispose();
		});

		it("diff returns empty changes on fresh space", async () => {
			const f = fixture();
			const created = await f.call("enclosure.create", { workspace: "/tmp/ws" });
			const spaceId = created.payload.spaceId as string;
			const diff = await f.call("enclosure.diff", { spaceId });
			expect(diff.isError).toBe(false);
			expect(diff.payload.changes).toEqual([]);
			f.dispose();
		});

		it("reset clears changes", async () => {
			const f = fixture();
			const created = await f.call("enclosure.create", { workspace: "/tmp/ws" });
			const spaceId = created.payload.spaceId as string;
			const reset = await f.call("enclosure.reset", { spaceId });
			expect(reset.isError).toBe(false);
			expect(reset.payload.ok).toBe(true);
			f.dispose();
		});

		it("snapshot and restore round-trip", async () => {
			const f = fixture();
			const created = await f.call("enclosure.create", { workspace: "/tmp/ws" });
			const spaceId = created.payload.spaceId as string;

			const snap = await f.call("enclosure.snapshot", { spaceId, name: "before-edit" });
			expect(snap.isError).toBe(false);

			const rest = await f.call("enclosure.restore", { spaceId, name: "before-edit" });
			expect(rest.isError).toBe(false);
			expect(rest.payload.name).toBe("before-edit");
			f.dispose();
		});

		it("exec returns output from stub", async () => {
			const f = fixture();
			const created = await f.call("enclosure.create", { workspace: "/tmp/ws" });
			const spaceId = created.payload.spaceId as string;
			const result = await f.call("enclosure.exec", { spaceId, command: ["echo", "hello"] });
			expect(result.isError).toBe(false);
			expect(result.payload.exitCode).toBe(0);
			expect(result.payload.output).toContain("echo hello");
			f.dispose();
		});

		it("destroy removes the space from registry", async () => {
			const f = fixture();
			const created = await f.call("enclosure.create", { workspace: "/tmp/ws" });
			const spaceId = created.payload.spaceId as string;

			const destroyed = await f.call("enclosure.destroy", { spaceId });
			expect(destroyed.isError).toBe(false);

			const destroyed2 = await f.call("enclosure.destroy", { spaceId });
			expect(destroyed2.isError).toBe(true);
			f.dispose();
		});

		it("unknown spaceId returns error", async () => {
			const f = fixture();
			const result = await f.call("enclosure.diff", { spaceId: "does-not-exist" });
			expect(result.isError).toBe(true);
			expect(result.errorMessage).toContain("unknown spaceId");
			f.dispose();
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
