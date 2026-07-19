/**
 * Hot-reload E2E tests -- verifies the rebuild + swap lifecycle.
 * Tests model state (trace events, swap calls), not rendered output.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHotReloadDescriptor,
	type HotReloadOpts,
	type HotReloadRebuildHandle,
	type HotReloadTrace,
} from "../src/hot-reload.js";

describe("hot-reload E2E", { tags: ["unit"] }, () => {
	let handle: HotReloadRebuildHandle | undefined;
	let stopped = false;

	afterEach(() => {
		handle = undefined;
		stopped = false;
	});

	function makeOpts(overrides: Partial<HotReloadOpts> = {}): HotReloadOpts {
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

	async function startService(opts: HotReloadOpts) {
		const descriptor = createHotReloadDescriptor(opts);
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();
		return service;
	}

	it("rebuild completes and calls swap", async () => {
		const opts = makeOpts();
		const service = await startService(opts);

		expect(handle).toBeDefined();
		await handle!.requestRebuild();

		expect(opts.swap).toHaveBeenCalledOnce();
		expect(opts.swap).toHaveBeenCalledWith("session", expect.objectContaining({ cwd: process.cwd() }));

		await service.stop();
		expect(stopped).toBe(true);
	});

	it("build failure does not leave rebuildInFlight stuck", async () => {
		const opts = makeOpts({ buildCommand: "exit 1" });
		const service = await startService(opts);

		await expect(handle!.requestRebuild()).rejects.toThrow();
		expect(opts.swap).not.toHaveBeenCalled();

		await service.stop();
	});

	it("concurrent rebuilds coalesce into one swap", async () => {
		let swapCount = 0;
		const opts = makeOpts({
			buildCommand: "sleep 0.2 && echo done",
			swap: vi.fn().mockImplementation(async () => {
				swapCount++;
			}),
		});
		const service = await startService(opts);

		const p1 = handle!.requestRebuild();
		const p2 = handle!.requestRebuild();
		await Promise.all([p1, p2]);

		expect(swapCount).toBe(1);

		await service.stop();
	});

	it("swap failure surfaces as thrown error", async () => {
		const opts = makeOpts({
			swap: vi.fn().mockRejectedValue(new Error("swap failed")),
		});
		const service = await startService(opts);

		await expect(handle!.requestRebuild()).rejects.toThrow("swap failed");

		await service.stop();
	});

	it("child stdin is closed so build never blocks on TUI input", async () => {
		const opts = makeOpts({
			buildCommand: "cat /dev/stdin 2>/dev/null; echo stdin-closed",
		});
		const service = await startService(opts);

		// If stdin were open, `cat` would hang forever. With stdin.end(),
		// cat gets EOF immediately and the command completes.
		await handle!.requestRebuild();
		expect(opts.swap).toHaveBeenCalledOnce();

		await service.stop();
	});

	describe("trace lifecycle", () => {
		it("emits build:start, build:done, swap:start, swap:done, complete on success", async () => {
			const traces: Array<{ phase: string; detail?: Record<string, unknown> }> = [];
			const trace: HotReloadTrace = (phase, detail) => {
				traces.push({ phase, detail });
			};
			const opts = makeOpts({ trace });
			const service = await startService(opts);

			await handle!.requestRebuild();

			const phases = traces.map((t) => t.phase);
			expect(phases).toEqual(["build:start", "build:done", "swap:start", "swap:done", "complete"]);

			// build:start has the command
			expect(traces[0]!.detail).toHaveProperty("command");

			// build:done and swap:done have elapsed ms
			expect(traces[1]!.detail).toHaveProperty("elapsedMs");
			expect(traces[3]!.detail).toHaveProperty("elapsedMs");

			// complete has total ms
			expect(traces[4]!.detail).toHaveProperty("totalMs");

			await service.stop();
		});

		it("emits build:start then error on build failure", async () => {
			const traces: Array<{ phase: string; detail?: Record<string, unknown> }> = [];
			const opts = makeOpts({
				buildCommand: "exit 1",
				trace: (phase, detail) => traces.push({ phase, detail }),
			});
			const service = await startService(opts);

			await expect(handle!.requestRebuild()).rejects.toThrow();

			const phases = traces.map((t) => t.phase);
			expect(phases).toEqual(["build:start", "error"]);
			expect(traces[1]!.detail).toHaveProperty("error");
			expect(traces[1]!.detail).toHaveProperty("elapsedMs");

			await service.stop();
		});

		it("emits swap:start then error on swap failure", async () => {
			const traces: Array<{ phase: string; detail?: Record<string, unknown> }> = [];
			const opts = makeOpts({
				swap: vi.fn().mockRejectedValue(new Error("swap boom")),
				trace: (phase, detail) => traces.push({ phase, detail }),
			});
			const service = await startService(opts);

			await expect(handle!.requestRebuild()).rejects.toThrow("swap boom");

			const phases = traces.map((t) => t.phase);
			expect(phases).toEqual(["build:start", "build:done", "swap:start", "error"]);

			await service.stop();
		});

		it("elapsed times are positive numbers", async () => {
			const traces: Array<{ phase: string; detail?: Record<string, unknown> }> = [];
			const opts = makeOpts({
				trace: (phase, detail) => traces.push({ phase, detail }),
			});
			const service = await startService(opts);

			await handle!.requestRebuild();

			for (const t of traces) {
				if (t.detail && "elapsedMs" in t.detail) {
					expect(t.detail.elapsedMs).toBeGreaterThanOrEqual(0);
				}
				if (t.detail && "totalMs" in t.detail) {
					expect(t.detail.totalMs).toBeGreaterThanOrEqual(0);
				}
			}

			await service.stop();
		});
	});
});
