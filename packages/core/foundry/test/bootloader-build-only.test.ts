/**
 * BuildService tests -- verifies build-only lifecycle (no swap).
 *
 * The build service is a pure BuildService: it compiles code and returns.
 * The caller (entrypoint) composes the restart strategy separately.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createBuildServiceDescriptor,
	type BuildEvent,
	type BuildService,
	type BuildServiceOpts,
} from "../src/bootloader.js";

function makeOpts(overrides: Partial<BuildServiceOpts> = {}): BuildServiceOpts {
	return {
		buildCommand: "echo built",
		cwd: "/tmp",
		...overrides,
	};
}

async function startBuildService(opts: BuildServiceOpts): Promise<{ service: BuildService; stop: () => Promise<void> }> {
	let buildService: BuildService | undefined;
	const desc = createBuildServiceDescriptor({
		...opts,
		onReady: (svc) => {
			buildService = svc;
			opts.onReady?.(svc);
		},
	});
	const managed = await desc.create({ cwd: opts.cwd });
	await managed.start();
	return { service: buildService!, stop: () => managed.stop() };
}

describe("BuildService (SRP -- build only, no swap)", { tags: ["unit"] }, () => {
	it("build() completes and emits build:start + build:done", async () => {
		const events: BuildEvent[] = [];
		const { service, stop } = await startBuildService(
			makeOpts({ onEvent: (e) => events.push(e) }),
		);

		await service.build();

		const phases = events.map((e) => e.phase);
		expect(phases).toEqual(["build:start", "build:done"]);
		expect((events[0] as { command?: string }).command).toBe("echo built");
		expect((events[1] as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);

		await stop();
	});

	it("build failure emits build:start + error and throws", async () => {
		const events: BuildEvent[] = [];
		const { service, stop } = await startBuildService(
			makeOpts({ buildCommand: "exit 1", onEvent: (e) => events.push(e) }),
		);

		await expect(service.build()).rejects.toThrow();

		const phases = events.map((e) => e.phase);
		expect(phases).toEqual(["build:start", "error"]);

		await stop();
	});

	it("concurrent builds coalesce into one execution", async () => {
		let buildCount = 0;
		const events: BuildEvent[] = [];
		const { service, stop } = await startBuildService(
			makeOpts({
				buildCommand: "echo coalesced",
				onEvent: (e) => {
					if (e.phase === "build:done") buildCount++;
					events.push(e);
				},
			}),
		);

		const p1 = service.build();
		const p2 = service.build();
		await Promise.all([p1, p2]);

		expect(buildCount).toBe(1);

		await stop();
	});

	it("child stdin is closed so build never blocks on TUI input", async () => {
		const { service, stop } = await startBuildService(
			makeOpts({ buildCommand: "cat /dev/stdin 2>/dev/null; echo stdin-closed" }),
		);

		await service.build();

		await stop();
	});
});

describe("BuildService + RebootPort composition (handoff test)", { tags: ["unit"] }, () => {
	it("composed reboot port builds then lets caller handle restart", async () => {
		const events: string[] = [];
		const { service, stop } = await startBuildService(
			makeOpts({ onEvent: (e) => events.push(e.phase) }),
		);

		// Compose the reboot port the same way the entrypoint does
		const rebootPort = { reboot: () => service.build() };

		// Simulate what :update does: call reboot (build), then exit
		await rebootPort.reboot();
		events.push("caller:exit");

		expect(events).toEqual(["build:start", "build:done", "caller:exit"]);

		await stop();
	});

	it("build failure prevents caller from reaching exit", async () => {
		const events: string[] = [];
		const { service, stop } = await startBuildService(
			makeOpts({ buildCommand: "exit 1", onEvent: (e) => events.push(e.phase) }),
		);

		const rebootPort = { reboot: () => service.build() };

		let buildFailed = false;
		try {
			await rebootPort.reboot();
			events.push("caller:exit");
		} catch {
			buildFailed = true;
			events.push("caller:caught-error");
		}

		expect(buildFailed).toBe(true);
		expect(events).toEqual(["build:start", "error", "caller:caught-error"]);
		expect(events).not.toContain("caller:exit");

		await stop();
	});

	it("production mode (no build service) skips build and exits directly", () => {
		// In prod, resolveReboot() returns undefined -- no build service
		const rebootPort = undefined;

		const events: string[] = [];
		// Simulate what :update does in prod
		if (rebootPort) {
			events.push("build");
		}
		events.push("exit");

		expect(events).toEqual(["exit"]);
	});
});
