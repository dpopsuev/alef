import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotReloadDescriptor } from "../src/hot-reload.js";

type AlefGlobal = typeof globalThis & {
	alefRequestRebuild?: () => Promise<void>;
};

function alefGlobal(): AlefGlobal {
	return globalThis as AlefGlobal;
}

afterEach(async () => {
	delete alefGlobal().alefRequestRebuild;
});

describe("createHotReloadDescriptor", { tags: ["unit"] }, () => {
	it("clears alefRequestRebuild and reports unhealthy after stop", async () => {
		const descriptor = createHotReloadDescriptor({
			buildCommand: "true",
			swap: vi.fn(),
			sessionServiceName: "session",
			cwd: process.cwd(),
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		expect(typeof alefGlobal().alefRequestRebuild).toBe("function");
		expect(await service.health()).toBe(true);

		await service.stop();

		expect(alefGlobal().alefRequestRebuild).toBeUndefined();
		expect(await service.health()).toBe(false);
	});

	it("clears alefRequestRebuild after a failed build when stop runs", async () => {
		const descriptor = createHotReloadDescriptor({
			buildCommand: "false",
			swap: vi.fn(),
			sessionServiceName: "session",
			cwd: process.cwd(),
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		await expect(alefGlobal().alefRequestRebuild?.()).rejects.toThrow();
		expect(typeof alefGlobal().alefRequestRebuild).toBe("function");

		await service.stop();
		expect(alefGlobal().alefRequestRebuild).toBeUndefined();
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
		});
		const service = await descriptor.create({ cwd: process.cwd() });
		await service.start();

		const rebuild = alefGlobal().alefRequestRebuild;
		expect(rebuild).toBeTypeOf("function");

		const first = rebuild!();
		const second = rebuild!();

		resolveBuild?.();
		await Promise.all([first, second]);

		expect(swap).toHaveBeenCalledTimes(1);

		await service.stop();
	});
});
