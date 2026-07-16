import { describe, expect, it, vi } from "vitest";
import { defineManagedService } from "../src/managed-service.js";

describe("defineManagedService", { tags: ["unit"] }, () => {
	it("fills default lifecycle and empty adapter payloads", async () => {
		const descriptor = defineManagedService({
			name: "session",
			restart: "permanent",
			shareable: true,
			dependsOn: ["storage"],
			create: async () => ({
				sessionId: "sess-1",
			}),
		});

		expect(descriptor.dependsOn).toEqual(["storage"]);

		const service = await descriptor.create({ cwd: "/tmp" });
		expect(service.name).toBe("session");
		expect(service.restart).toBe("permanent");
		expect(service.adapters).toEqual([]);
		expect(service.tools).toEqual([]);
		expect("sessionId" in service && service.sessionId).toBe("sess-1");

		await expect(service.start()).resolves.toBeUndefined();
		await expect(service.stop()).resolves.toBeUndefined();
		await expect(service.health()).resolves.toBe(true);
	});

	it("preserves custom lifecycle overrides and extra fields", async () => {
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const descriptor = defineManagedService({
			name: "agent",
			restart: "transient",
			shareable: false,
			create: () => ({
				heartbeat: 5,
				start,
				stop,
				health: async () => false,
			}),
		});

		const service = await descriptor.create({ cwd: "/tmp" });
		await service.start();
		await service.stop();

		expect("heartbeat" in service && service.heartbeat).toBe(5);
		expect(start).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
		await expect(service.health()).resolves.toBe(false);
	});
});
