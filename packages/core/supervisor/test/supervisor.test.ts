import { describe, expect, it, vi } from "vitest";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ManagedService, ServiceDescriptor } from "../src/lifecycle.js";
import { Supervisor } from "../src/supervisor.js";

function makeDescriptor(
	name: string,
	factory: () => ManagedService,
	restart: ServiceDescriptor["restart"] = "permanent",
): ServiceDescriptor {
	return {
		name,
		restart,
		shareable: true,
		async create() {
			return factory();
		},
	};
}

function makeInstance(overrides: Partial<ManagedService> = {}): ManagedService {
	return {
		name: "svc",
		restart: "permanent",
		adapters: [],
		tools: [],
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		health: vi.fn(async () => true),
		...overrides,
	};
}

function makeLogger(): AdapterLogger {
	const logger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	};
	logger.child.mockReturnValue(logger);
	return logger;
}

describe("Supervisor swap and health", { tags: ["unit"] }, () => {
	it("keeps the old instance when next.start throws", async () => {
		const supervisor = new Supervisor();
		const oldInstance = makeInstance({ name: "old" });
		const nextInstance = makeInstance({
			name: "next",
			start: vi.fn(async () => {
				throw new Error("boot failed");
			}),
		});
		let createCount = 0;
		supervisor.register(
			makeDescriptor("session", () => {
				createCount += 1;
				return createCount === 1 ? oldInstance : nextInstance;
			}, "temporary"),
		);
		await supervisor.startAll({ cwd: "/tmp" });

		await expect(supervisor.swap("session", { cwd: "/tmp" })).rejects.toThrow("boot failed");
		expect(supervisor.get("session")).toBe(oldInstance);
		expect(nextInstance.stop).toHaveBeenCalledOnce();
		expect(oldInstance.stop).not.toHaveBeenCalled();
	});

	it("logs when restart budget is exhausted", async () => {
		const logger = makeLogger();
		const supervisor = new Supervisor();
		const instance = makeInstance({ health: vi.fn(async () => false) });
		supervisor.register(makeDescriptor("session", () => instance, "temporary"));
		await supervisor.startAll({ cwd: "/tmp", logger });

		const entry = (
			supervisor as unknown as {
				running: Map<string, { restartTimestamps: number[] }>;
			}
		).running.get("session")!;
		entry.restartTimestamps = [Date.now(), Date.now(), Date.now()];

		await (
			supervisor as unknown as {
				checkHealth: (e: unknown, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
			}
		).checkHealth(entry, { cwd: "/tmp", logger });

		expect(logger.error).toHaveBeenCalled();
		expect(instance.start).toHaveBeenCalledOnce();
	});

	it("does not double-create under overlapping checkHealth", async () => {
		vi.useFakeTimers();
		const supervisor = new Supervisor();
		let creates = 0;
		supervisor.register(
			makeDescriptor("session", () => {
				creates += 1;
				return makeInstance({
					health: vi.fn(async () => (creates === 1 ? false : true)),
				});
			}, "temporary"),
		);
		await supervisor.startAll({ cwd: "/tmp" });

		const entry = (supervisor as unknown as { running: Map<string, unknown> }).running.get("session");
		const checkHealth = (
			supervisor as unknown as {
				checkHealth: (e: unknown, opts: { cwd: string }) => Promise<void>;
			}
		).checkHealth.bind(supervisor);

		const firstCheck = checkHealth(entry, { cwd: "/tmp" });
		const secondCheck = checkHealth(entry, { cwd: "/tmp" });
		await vi.advanceTimersByTimeAsync(15_000);
		await Promise.all([firstCheck, secondCheck]);

		expect(creates).toBe(2);
		vi.useRealTimers();
	});
});
