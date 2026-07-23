import type { ManagedService } from "@dpopsuev/alef-supervisor/lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDaemonServiceDescriptor,
	type DaemonRegistrySource,
	type DiscoverableDaemon,
	discoverDaemons,
	isDaemonAlive,
} from "../src/daemon-registry.js";
import { createFoundryRuntime } from "../src/runtime.js";

function makeEntry(overrides: Partial<DiscoverableDaemon> = {}): DiscoverableDaemon {
	return {
		sessionId: "session-a",
		pid: 999999, // unlikely to be a real running pid
		host: "127.0.0.1",
		port: 4000,
		cwd: "/tmp",
		startedAt: Date.now(),
		...overrides,
	};
}

describe("isDaemonAlive", { tags: ["unit"] }, () => {
	it("is alive when the last heartbeat is recent", () => {
		expect(isDaemonAlive(makeEntry({ lastHeartbeat: Date.now() - 1000 }), 60_000)).toBe(true);
	});

	it("is not alive when the last heartbeat is older than the stale threshold", () => {
		expect(isDaemonAlive(makeEntry({ lastHeartbeat: Date.now() - 120_000 }), 60_000)).toBe(false);
	});

	it("falls back to startedAt when there is no heartbeat yet", () => {
		expect(isDaemonAlive(makeEntry({ startedAt: Date.now() - 1000, lastHeartbeat: undefined }), 60_000)).toBe(true);
	});
});

describe("createDaemonServiceDescriptor", { tags: ["unit"] }, () => {
	it("stop() kills the pid and unregisters from the persistent registry", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const unregister = vi.fn(async () => {});
		const registry: DaemonRegistrySource = {
			list: async () => [],
			unregister,
			prune: async () => 0,
		};
		const entry = makeEntry({ pid: 424242 });

		const descriptor = createDaemonServiceDescriptor(entry, registry);
		const svc: ManagedService = await descriptor.create({ cwd: "/tmp" });
		await svc.stop();

		expect(killSpy).toHaveBeenCalledWith(424242, "SIGTERM");
		expect(unregister).toHaveBeenCalledWith("session-a");
		killSpy.mockRestore();
	});

	it("stop() does not throw when the process is already gone", async () => {
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		const unregister = vi.fn(async () => {});
		const registry: DaemonRegistrySource = { list: async () => [], unregister, prune: async () => 0 };
		const descriptor = createDaemonServiceDescriptor(makeEntry(), registry);
		const svc = await descriptor.create({ cwd: "/tmp" });

		await expect(svc.stop()).resolves.toBeUndefined();
		expect(unregister).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("health() reflects heartbeat freshness", async () => {
		const registry: DaemonRegistrySource = { list: async () => [], unregister: async () => {}, prune: async () => 0 };
		const stale = createDaemonServiceDescriptor(makeEntry({ lastHeartbeat: Date.now() - 999_999 }), registry, 1000);
		const svc = await stale.create({ cwd: "/tmp" });

		expect(await svc.health()).toBe(false);
	});
});

describe("discoverDaemons", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers each non-self, live daemon as a ManagedService on the host", async () => {
		vi.spyOn(process, "kill").mockImplementation(() => true);
		const entries = [makeEntry({ sessionId: "self" }), makeEntry({ sessionId: "sibling-1" }), makeEntry({ sessionId: "sibling-2" })];
		const registry: DaemonRegistrySource = {
			list: async () => entries,
			unregister: async () => {},
			prune: async () => 0,
		};

		const runtime = createFoundryRuntime({ cwd: "/tmp" });
		const discovered = await discoverDaemons(runtime, registry, { selfSessionId: "self", cwd: "/tmp" });

		expect(discovered.map((d) => d.sessionId).sort()).toEqual(["sibling-1", "sibling-2"]);
		expect(runtime.names()).toContain("sibling-1");
		expect(runtime.names()).toContain("sibling-2");
		expect(runtime.names()).not.toContain("self");
	});

	it("prunes stale entries from the persistent registry before discovery", async () => {
		const prune = vi.fn(async () => 2);
		const registry: DaemonRegistrySource = { list: async () => [], unregister: async () => {}, prune };
		const runtime = createFoundryRuntime({ cwd: "/tmp" });

		await discoverDaemons(runtime, registry, { cwd: "/tmp", staleMs: 5000 });

		expect(prune).toHaveBeenCalledWith(5000);
	});

	it("a discovered sibling can be stopped uniformly through the host, like any other service", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const unregister = vi.fn(async () => {});
		const registry: DaemonRegistrySource = {
			list: async () => [makeEntry({ sessionId: "sibling-1", pid: 555 })],
			unregister,
			prune: async () => 0,
		};
		const runtime = createFoundryRuntime({ cwd: "/tmp" });
		await discoverDaemons(runtime, registry, { cwd: "/tmp" });

		await runtime.stopService("sibling-1");

		expect(killSpy).toHaveBeenCalledWith(555, "SIGTERM");
		expect(unregister).toHaveBeenCalledWith("sibling-1");
		expect(runtime.get("sibling-1")).toBeUndefined();
	});
});
