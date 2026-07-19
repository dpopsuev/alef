import { afterEach, describe, expect, it, vi } from "vitest";
import { createBootloaderDescriptor, type RebootHandle } from "../src/bootloader.js";

describe("createBootloaderDescriptor", { tags: ["unit"] }, () => {
	let handle: RebootHandle | undefined;

	afterEach(async () => {
		handle = undefined;
	});

	it("invokes onReady/onStopped and reports health", async () => {
		const onReady = vi.fn((readyHandle: RebootHandle) => {
			handle = readyHandle;
		});
		const onStopped = vi.fn(() => {
			handle = undefined;
		});
		const descriptor = createBootloaderDescriptor({
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
		expect(handle?.reboot).toBeTypeOf("function");
		expect(await service.health()).toBe(true);

		await service.stop();

		expect(onStopped).toHaveBeenCalledOnce();
		expect(handle).toBeUndefined();
		expect(await service.health()).toBe(false);
	});

	it("keeps handle after a failed build until stop", async () => {
		const onReady = vi.fn((readyHandle: RebootHandle) => {
			handle = readyHandle;
		});
		const descriptor = createBootloaderDescriptor({
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

		await expect(handle?.reboot()).rejects.toThrow();
		expect(handle?.reboot).toBeTypeOf("function");

		await service.stop();
		expect(handle).toBeUndefined();
		expect(await service.health()).toBe(false);
	});

	it("guards concurrent reboots with a single in-flight swap", async () => {
		let resolveBuild: (() => void) | undefined;
		const buildGate = new Promise<void>((resolve) => {
			resolveBuild = resolve;
		});
		const swap = vi.fn(async (_serviceName: string, _opts: { cwd: string }) => {});

		const descriptor = createBootloaderDescriptor({
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

		expect(handle?.reboot).toBeTypeOf("function");

		const first = handle!.reboot();
		const second = handle!.reboot();

		resolveBuild?.();
		await Promise.all([first, second]);

		expect(swap).toHaveBeenCalledTimes(1);

		await service.stop();
	});
});
