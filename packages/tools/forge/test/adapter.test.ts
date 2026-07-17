import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createForgeAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createForgeAdapter({ cwd: "/tmp" }));

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-forge-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@alef.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Alef Test"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "base\n");
	execFileSync("git", ["add", "README.md"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

function invoke(
	bus: InProcessBus,
	type: string,
	payload: Record<string, unknown>,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
	const correlationId = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
		const off = bus.asBus().event.subscribe(type, (event) => {
			if (event.correlationId !== correlationId) return;
			clearTimeout(timer);
			off();
			resolve({
				isError: event.isError,
				payload: event.payload as Record<string, unknown>,
			});
		});
		bus.asBus().command.publish({ type, correlationId, payload });
	});
}

describe("forge local PR store", { tags: ["unit"] }, () => {
	it("create → review → merge emits domain events and merges git", async () => {
		const cwd = initRepo();
		execFileSync("git", ["checkout", "-b", "feature"], { cwd });
		writeFileSync(join(cwd, "feature.txt"), "hello\n");
		execFileSync("git", ["add", "feature.txt"], { cwd });
		execFileSync("git", ["commit", "-m", "feature"], { cwd });

		const bus = new InProcessBus();
		const adapter = createForgeAdapter({ cwd, forgeRoot: join(cwd, ".forge-store") });
		const unmount = adapter.mount(bus.asBus());
		const opened: number[] = [];
		const reviewed: number[] = [];
		const updated: Array<Record<string, unknown>> = [];
		try {
			bus.asBus().notification.subscribe("pr.opened", (event) => {
				if (typeof event.payload.number === "number") opened.push(event.payload.number);
			});
			bus.asBus().notification.subscribe("pr.reviewed", (event) => {
				if (typeof event.payload.number === "number") reviewed.push(event.payload.number);
			});
			bus.asBus().notification.subscribe("pr.updated", (event) => {
				updated.push(event.payload as Record<string, unknown>);
			});

			const created = await invoke(bus, "forge.pr.create", {
				title: "Add feature",
				head: "feature",
				base: "main",
				body: "test pr",
			});
			expect(created.isError).toBe(false);
			expect(opened).toEqual([1]);

			const got = await invoke(bus, "forge.pr.get", { number: 1 });
			expect(got.isError).toBe(false);
			expect(String(got.payload.summary ?? "")).toContain("feature.txt");

			const review = await invoke(bus, "forge.pr.review", {
				number: 1,
				body: "LGTM",
				event: "APPROVED",
			});
			expect(review.isError).toBe(false);
			expect(reviewed).toEqual([1]);

			const merged = await invoke(bus, "forge.pr.merge", { number: 1 });
			expect(merged.isError).toBe(false);
			expect(updated.some((payload) => payload.action === "merged")).toBe(true);

			const onMain = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf-8" }).trim();
			expect(onMain).toBe("main");
			const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
				cwd,
				encoding: "utf-8",
			});
			expect(files).toContain("feature.txt");
		} finally {
			unmount();
		}
	});
});

describe("forge.ingest", { tags: ["unit"] }, () => {
	it("publishes pr.opened on the notification bus", async () => {
		const bus = new InProcessBus();
		const adapter = createForgeAdapter({ cwd: "/tmp" });
		const unmount = adapter.mount(bus.asBus());
		const seen: number[] = [];
		try {
			bus.asBus().notification.subscribe("pr.opened", (event) => {
				if (typeof event.payload.number === "number") seen.push(event.payload.number);
			});
			const result = await invoke(bus, "forge.ingest", {
				body: {
					action: "opened",
					pull_request: {
						number: 12,
						title: "t",
						state: "open",
						head: { ref: "a" },
						base: { ref: "main" },
					},
					repository: { full_name: "alef/alef" },
				},
			});
			expect(result.isError).toBe(false);
			expect(result.payload.published).toBe(1);
			expect(seen).toEqual([12]);
		} finally {
			unmount();
		}
	});
});
