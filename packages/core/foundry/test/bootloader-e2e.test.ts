/**
 * Bootloader E2E tests -- verifies the rebuild + swap lifecycle.
 * Tests model state (boot events, swap calls), not rendered output.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createBootloaderDescriptor,
	type BootEvent,
	type BootEventListener,
	type BootloaderOpts,
	type RebootHandle,
} from "../src/bootloader.js";

describe("bootloader E2E", { tags: ["unit"] }, () => {
	let handle: RebootHandle | undefined;
	let stopped = false;

	afterEach(() => {
		handle = undefined;
		stopped = false;
	});

	function makeOpts(overrides: Partial<BootloaderOpts> = {}): BootloaderOpts {
		return {
			buildCommand: "echo build-ok",
			cwd: process.cwd(),
			sessionServiceName: "session",
			swap: vi.fn().mockResolvedValue(undefined),
			onReady: (h) => {
				handle = h;
			},
			onStopped: () => {
				stopped = true;
			},
			...overrides,
		};
	}

	async function startService(opts: BootloaderOpts) {
		const descriptor = createBootloaderDescriptor(opts);
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();
		return service;
	}

	it("reboot completes and calls swap", async () => {
		const opts = makeOpts();
		const service = await startService(opts);

		expect(handle).toBeDefined();
		await handle!.reboot();

		expect(opts.swap).toHaveBeenCalledOnce();
		expect(opts.swap).toHaveBeenCalledWith("session", expect.objectContaining({ cwd: process.cwd() }));

		await service.stop();
		expect(stopped).toBe(true);
	});

	it("build failure does not leave reboot stuck", async () => {
		const opts = makeOpts({ buildCommand: "exit 1" });
		const service = await startService(opts);

		await expect(handle!.reboot()).rejects.toThrow();
		expect(opts.swap).not.toHaveBeenCalled();

		await service.stop();
	});

	it("concurrent reboots coalesce into one swap", async () => {
		let swapCount = 0;
		const opts = makeOpts({
			buildCommand: "sleep 0.2 && echo done",
			swap: vi.fn().mockImplementation(async () => {
				swapCount++;
			}),
		});
		const service = await startService(opts);

		const p1 = handle!.reboot();
		const p2 = handle!.reboot();
		await Promise.all([p1, p2]);

		expect(swapCount).toBe(1);

		await service.stop();
	});

	it("swap failure surfaces as thrown error", async () => {
		const opts = makeOpts({
			swap: vi.fn().mockRejectedValue(new Error("swap failed")),
		});
		const service = await startService(opts);

		await expect(handle!.reboot()).rejects.toThrow("swap failed");

		await service.stop();
	});

	it("child stdin is closed so build never blocks on TUI input", async () => {
		const opts = makeOpts({
			buildCommand: "cat /dev/stdin 2>/dev/null; echo stdin-closed",
		});
		const service = await startService(opts);

		await handle!.reboot();
		expect(opts.swap).toHaveBeenCalledOnce();

		await service.stop();
	});

	describe("boot event lifecycle", () => {
		it("emits build:start, build:done, swap:start, swap:done, complete on success", async () => {
			const events: BootEvent[] = [];
			const onEvent: BootEventListener = (event) => {
				events.push(event);
			};
			const opts = makeOpts({ onEvent });
			const service = await startService(opts);

			await handle!.reboot();

			const phases = events.map((e) => e.phase);
			expect(phases).toEqual(["build:start", "build:done", "swap:start", "swap:done", "complete"]);

			// build:start has the command
			expect((events[0] as { command?: string }).command).toBeDefined();

			// build:done and swap:done have elapsed ms
			expect((events[1] as { elapsedMs?: number }).elapsedMs).toBeDefined();
			expect((events[3] as { elapsedMs?: number }).elapsedMs).toBeDefined();

			// complete has total ms
			expect((events[4] as { totalMs?: number }).totalMs).toBeDefined();

			await service.stop();
		});

		it("emits build:start then error on build failure", async () => {
			const events: BootEvent[] = [];
			const opts = makeOpts({
				buildCommand: "exit 1",
				onEvent: (event) => events.push(event),
			});
			const service = await startService(opts);

			await expect(handle!.reboot()).rejects.toThrow();

			const phases = events.map((e) => e.phase);
			expect(phases).toEqual(["build:start", "error"]);
			expect((events[1] as { error?: string }).error).toBeDefined();
			expect((events[1] as { elapsedMs?: number }).elapsedMs).toBeDefined();

			await service.stop();
		});

		it("emits swap:start then error on swap failure", async () => {
			const events: BootEvent[] = [];
			const opts = makeOpts({
				swap: vi.fn().mockRejectedValue(new Error("swap boom")),
				onEvent: (event) => events.push(event),
			});
			const service = await startService(opts);

			await expect(handle!.reboot()).rejects.toThrow("swap boom");

			const phases = events.map((e) => e.phase);
			expect(phases).toEqual(["build:start", "build:done", "swap:start", "error"]);

			await service.stop();
		});

		it("elapsed times are positive numbers", async () => {
			const events: BootEvent[] = [];
			const opts = makeOpts({
				onEvent: (event) => events.push(event),
			});
			const service = await startService(opts);

			await handle!.reboot();

			for (const e of events) {
				if ("elapsedMs" in e) {
					expect(e.elapsedMs).toBeGreaterThanOrEqual(0);
				}
				if ("totalMs" in e) {
					expect(e.totalMs).toBeGreaterThanOrEqual(0);
				}
			}

			await service.stop();
		});
	});
});
