import { z } from "zod";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { describe, expect, it, vi } from "vitest";
import { defineAdapterService } from "../src/adapter-service.js";

function makeAdapter(name: string, close?: () => Promise<void>): Adapter {
	return {
		name,
		tools: [
			{
				name: `${name}.ping`,
				description: "Ping tool",
				inputSchema: z.object({}),
			},
		],
		subscriptions: { command: [], event: [], notification: [] },
		sources: [],
		mount: () => () => {},
		close,
	};
}

describe("defineAdapterService", { tags: ["unit"] }, () => {
	it("wraps adapters with default lifecycle and cleanup", async () => {
		const close = vi.fn(async () => {});
		const descriptor = defineAdapterService({
			name: "echo",
			restart: "transient",
			shareable: true,
			dependsOn: ["session"],
			createAdapter: async () => makeAdapter("echo", close),
		});

		expect(descriptor.dependsOn).toEqual(["session"]);

		const service = await descriptor.create({ cwd: "/tmp" });
		expect(service.name).toBe("echo");
		expect(service.tools.map((tool) => tool.name)).toEqual(["echo.ping"]);

		await service.start();
		await service.stop();

		expect(close).toHaveBeenCalledOnce();
		await expect(service.health()).resolves.toBe(true);
	});

	it("supports custom lifecycle overrides", async () => {
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const descriptor = defineAdapterService({
			name: "custom",
			restart: "temporary",
			shareable: false,
			createAdapter: async () => makeAdapter("custom"),
			start,
			stop,
			health: () => false,
		});

		const service = await descriptor.create({ cwd: "/tmp" });
		await service.start();
		await service.stop();

		expect(start).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
		await expect(service.health()).resolves.toBe(false);
	});
});
