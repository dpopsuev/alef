import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotReloadDescriptor, type HotReloadRebuildHandle } from "../src/hot-reload.js";

describe("createHotReloadDescriptor", { tags: ["unit"] }, () => {
	let handle: HotReloadRebuildHandle | undefined;

	afterEach(async () => {
		handle = undefined;
	});

	it("invokes onReady/onStopped and reports health", async () => {
		const onReady = vi.fn((readyHandle: HotReloadRebuildHandle) => {
			handle = readyHandle;
		});
		const onStopped = vi.fn(() => {
			handle = undefined;
		});
		const descriptor = createHotReloadDescriptor({
			buildCommand: "true",
			swap: vi.fn(),
			sessionServiceName: "session",
			cwd: process.cwd(),
			onReady,
			onStopped,
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		expect(onReady).toHaveBeenCalledOnce();
		expect(handle?.requestRebuild).toBeTypeOf("function");
		expect(await service.health()).toBe(true);

		await service.stop();

		expect(onStopped).toHaveBeenCalledOnce();
		expect(handle).toBeUndefined();
		expect(await service.health()).toBe(false);
	});

	it("keeps handle after a failed build until stop", async () => {
		const onReady = vi.fn((readyHandle: HotReloadRebuildHandle) => {
			handle = readyHandle;
		});
		const descriptor = createHotReloadDescriptor({
			buildCommand: "false",
			swap: vi.fn(),
			sessionServiceName: "session",
			cwd: process.cwd(),
			onReady,
			onStopped: () => {
				handle = undefined;
			},
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		await expect(handle?.requestRebuild()).rejects.toThrow();
		expect(handle?.requestRebuild).toBeTypeOf("function");

		await service.stop();
		expect(handle).toBeUndefined();
		expect(await service.health()).toBe(false);
	});

	it("guards concurrent rebuilds with a single in-flight swap", async () => {
		let resolveBuild: (() => void) | undefined;
		const buildGate = new Promise<void>((resolve) => {
			resolveBuild = resolve;
		});
		const swap = vi.fn(async (_serviceName: string, _opts: { cwd: string }) => {});

		const descriptor = createHotReloadDescriptor({
			buildCommand: "true",
			swap: async (serviceName, opts) => {
				await buildGate;
				await swap(serviceName, opts);
			},
			sessionServiceName: "session",
			cwd: process.cwd(),
			onReady: (readyHandle) => {
				handle = readyHandle;
			},
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		expect(handle?.requestRebuild).toBeTypeOf("function");

		const first = handle!.requestRebuild();
		const second = handle!.requestRebuild();

		resolveBuild?.();
		await Promise.all([first, second]);

		expect(swap).toHaveBeenCalledTimes(1);

		await service.stop();
	});
});
