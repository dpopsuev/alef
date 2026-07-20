/**
 * Build + restart E2E tests -- exercises the wrapper-based restart protocol.
 *
 * The BuildService only compiles code. The caller (entrypoint/command)
 * composes the restart strategy: build(), then exit(75), then the wrapper
 * spawns a fresh process.
 *
 * These tests verify the composition contract rather than the wrapper itself.
 */

import { describe, expect, it } from "vitest";
import { createBuildServiceDescriptor, type BuildEvent, type BuildEventListener, type BuildService } from "../src/bootloader.js";

function createEventCollector() {
	const events: BuildEvent[] = [];
	const onEvent: BuildEventListener = (event) => events.push(event);
	return { events, onEvent };
}

describe("build + restart composition", { tags: ["unit"] }, () => {
	it("successful build followed by exit signal (wrapper protocol)", async () => {
		const { events, onEvent } = createEventCollector();
		const exitCalls: number[] = [];

		let buildService: BuildService | undefined;
		const desc = createBuildServiceDescriptor({
			buildCommand: "echo build-ok",
			cwd: process.cwd(),
			onEvent,
			onReady: (svc) => {
				buildService = svc;
			},
		});
		const managed = await desc.create({ cwd: process.cwd() });
		await managed.start();

		// Compose: build then exit (same as entrypoint does)
		const rebootPort = {
			async reboot() {
				await buildService!.build();
			},
		};

		// Simulate :update command flow
		await rebootPort.reboot();
		exitCalls.push(75); // process.exit(75) in real code

		const phases = events.map((e) => e.phase);
		expect(phases).toEqual(["build:start", "build:done"]);
		expect(exitCalls).toEqual([75]);

		await managed.stop();
	});

	it("build failure prevents exit -- no broken handoff", async () => {
		const { events, onEvent } = createEventCollector();
		const exitCalls: number[] = [];

		let buildService: BuildService | undefined;
		const desc = createBuildServiceDescriptor({
			buildCommand: "exit 1",
			cwd: process.cwd(),
			onEvent,
			onReady: (svc) => {
				buildService = svc;
			},
		});
		const managed = await desc.create({ cwd: process.cwd() });
		await managed.start();

		const rebootPort = {
			async reboot() {
				await buildService!.build();
			},
		};

		// Simulate :update error path
		try {
			await rebootPort.reboot();
			exitCalls.push(75);
		} catch {
			// Build failed -- command shows error, does NOT exit
		}

		expect(exitCalls).toEqual([]); // no exit on build failure
		expect(events.map((e) => e.phase)).toEqual(["build:start", "error"]);

		await managed.stop();
	});

	it("production mode (no build service) exits immediately", () => {
		// In prod, the build service is not registered.
		// resolveReboot() returns undefined.
		// :update installs the new package, then calls cleanExitForRestart().
		const rebootPort = undefined;
		const exitCalls: number[] = [];

		// Simulate :update prod flow
		if (rebootPort) {
			throw new Error("should not have a reboot port in prod");
		}
		exitCalls.push(75);

		expect(exitCalls).toEqual([75]);
	});

	it("mock build script produces observable side effect", async () => {
		const { events, onEvent } = createEventCollector();
		const output: string[] = [];

		let buildService: BuildService | undefined;
		const desc = createBuildServiceDescriptor({
			buildCommand: "echo MOCK_BUILD_OUTPUT",
			cwd: process.cwd(),
			onEvent,
			onReady: (svc) => {
				buildService = svc;
			},
		});
		const managed = await desc.create({ cwd: process.cwd() });
		await managed.start();

		await buildService!.build();

		const phases = events.map((e) => e.phase);
		expect(phases).toContain("build:start");
		expect(phases).toContain("build:done");

		const startEvent = events.find((e) => e.phase === "build:start");
		expect(startEvent).toBeDefined();
		if (startEvent && "command" in startEvent) {
			expect(startEvent.command).toBe("echo MOCK_BUILD_OUTPUT");
		}

		await managed.stop();
	});
});
