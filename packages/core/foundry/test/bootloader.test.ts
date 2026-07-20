import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildServiceDescriptor, type BuildService } from "../src/bootloader.js";

describe("createBuildServiceDescriptor", { tags: ["unit"] }, () => {
	let service: BuildService | undefined;

	afterEach(async () => {
		service = undefined;
	});

	it("invokes onReady/onStopped and reports health", async () => {
		const onReady = vi.fn((svc: BuildService) => {
			service = svc;
		});
		const onStopped = vi.fn(() => {
			service = undefined;
		});
		const descriptor = createBuildServiceDescriptor({
			buildCommand: "true",
			cwd: process.cwd(),
			onReady,
			onStopped,
		});
		const managed = await descriptor.create({ cwd: process.cwd() });
		await managed.start();

		expect(onReady).toHaveBeenCalledOnce();
		expect(service?.build).toBeTypeOf("function");
		expect(await managed.health()).toBe(true);

		await managed.stop();

		expect(onStopped).toHaveBeenCalledOnce();
		expect(service).toBeUndefined();
		expect(await managed.health()).toBe(false);
	});

	it("keeps service after a failed build until stop", async () => {
		const onReady = vi.fn((svc: BuildService) => {
			service = svc;
		});
		const descriptor = createBuildServiceDescriptor({
			buildCommand: "false",
			cwd: process.cwd(),
			onReady,
			onStopped: () => {
				service = undefined;
			},
		});
		const managed = await descriptor.create({ cwd: process.cwd() });
		await managed.start();

		await expect(service?.build()).rejects.toThrow();
		expect(service?.build).toBeTypeOf("function");

		await managed.stop();
		expect(service).toBeUndefined();
		expect(await managed.health()).toBe(false);
	});

	it("guards concurrent builds with a single in-flight execution", async () => {
		let buildCount = 0;
		const descriptor = createBuildServiceDescriptor({
			buildCommand: "sleep 0.1 && echo done",
			cwd: process.cwd(),
			onReady: (svc) => {
				service = svc;
			},
			onEvent: (e) => {
				if (e.phase === "build:done") buildCount++;
			},
		});
		const managed = await descriptor.create({ cwd: process.cwd() });
		await managed.start();

		const first = service!.build();
		const second = service!.build();

		await Promise.all([first, second]);

		expect(buildCount).toBe(1);

		await managed.stop();
	});
});
