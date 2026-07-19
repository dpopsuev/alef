/**
 * BuildService E2E tests -- verifies the build lifecycle with real shell commands.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createBuildServiceDescriptor,
	type BuildEvent,
	type BuildEventListener,
	type BuildService,
	type BuildServiceOpts,
} from "../src/bootloader.js";

describe("BuildService E2E", { tags: ["unit"] }, () => {
	let service: BuildService | undefined;

	afterEach(() => {
		service = undefined;
	});

	function makeOpts(overrides: Partial<BuildServiceOpts> = {}): BuildServiceOpts {
		return {
			buildCommand: "echo build-ok",
			cwd: process.cwd(),
			onReady: (svc) => {
				service = svc;
			},
			...overrides,
		};
	}

	async function startService(opts: BuildServiceOpts) {
		const descriptor = createBuildServiceDescriptor(opts);
		const managed = await descriptor.create({ cwd: process.cwd() });
		await managed.start();
		return managed;
	}

	it("build completes successfully", async () => {
		const managed = await startService(makeOpts());
		expect(service).toBeDefined();
		await service!.build();
		await managed.stop();
	});

	it("build failure does not leave build stuck", async () => {
		const managed = await startService(makeOpts({ buildCommand: "exit 1" }));
		await expect(service!.build()).rejects.toThrow();

		// Can try again after failure
		await expect(service!.build()).rejects.toThrow();

		await managed.stop();
	});

	it("concurrent builds coalesce into one execution", async () => {
		let buildCount = 0;
		const managed = await startService(
			makeOpts({
				buildCommand: "sleep 0.2 && echo done",
				onEvent: (e) => {
					if (e.phase === "build:done") buildCount++;
				},
			}),
		);

		const p1 = service!.build();
		const p2 = service!.build();
		await Promise.all([p1, p2]);

		expect(buildCount).toBe(1);

		await managed.stop();
	});

	it("child stdin is closed so build never blocks on TUI input", async () => {
		const managed = await startService(
			makeOpts({
				buildCommand: "cat /dev/stdin 2>/dev/null; echo stdin-closed",
			}),
		);

		await service!.build();

		await managed.stop();
	});

	describe("build event lifecycle", () => {
		it("emits build:start and build:done on success", async () => {
			const events: BuildEvent[] = [];
			const onEvent: BuildEventListener = (event) => events.push(event);
			const managed = await startService(makeOpts({ onEvent }));

			await service!.build();

			const phases = events.map((e) => e.phase);
			expect(phases).toEqual(["build:start", "build:done"]);

			expect((events[0] as { command?: string }).command).toBeDefined();
			expect((events[1] as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);

			await managed.stop();
		});

		it("emits build:start then error on build failure", async () => {
			const events: BuildEvent[] = [];
			const managed = await startService(
				makeOpts({
					buildCommand: "exit 1",
					onEvent: (event) => events.push(event),
				}),
			);

			await expect(service!.build()).rejects.toThrow();

			const phases = events.map((e) => e.phase);
			expect(phases).toEqual(["build:start", "error"]);
			expect((events[1] as { error?: string }).error).toBeDefined();

			await managed.stop();
		});

		it("elapsed times are positive numbers", async () => {
			const events: BuildEvent[] = [];
			const managed = await startService(
				makeOpts({ onEvent: (event) => events.push(event) }),
			);

			await service!.build();

			for (const e of events) {
				if ("elapsedMs" in e) {
					expect(e.elapsedMs).toBeGreaterThanOrEqual(0);
				}
			}

			await managed.stop();
		});
	});
});
