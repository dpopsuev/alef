/**
 * Restart E2E tests -- exercises the full hot-reload lifecycle through
 * the real Supervisor. Session create() calls getOrStart() for dependents,
 * simulating the real materializer path.
 */

import { describe, expect, it } from "vitest";
import { createHotReloadDescriptor, type HotReloadTrace } from "../src/hot-reload.js";
import { defineManagedService } from "../src/managed-service.js";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import type { ServiceCreateOpts } from "@dpopsuev/alef-supervisor/lifecycle";

function createTraceCollector() {
	const events: { phase: string; detail?: Record<string, unknown> }[] = [];
	const trace: HotReloadTrace = (phase, detail) => events.push({ phase, detail });
	return { events, trace };
}

describe("restart E2E", { tags: ["unit"] }, () => {
	it("dependents are re-created via getOrStart during session swap", async () => {
		const supervisor = new Supervisor();
		const { events, trace } = createTraceCollector();

		// Track plan lifecycle
		let planCreateCount = 0;
		let planStopCount = 0;
		const planDescriptor = defineManagedService({
			name: "plan",
			restart: "transient",
			shareable: false,
			dependsOn: ["session"],
			create() {
				planCreateCount++;
				let running = false;
				return Promise.resolve({
					start() { running = true; return Promise.resolve(); },
					stop() { planStopCount++; running = false; return Promise.resolve(); },
					health: () => Promise.resolve(running),
				});
			},
		});

		// Session create() calls getOrStart("plan") -- like the real materializer
		let sessionCreateCount = 0;
		const sessionDescriptor = defineManagedService({
			name: "session",
			restart: "permanent",
			shareable: true,
			async create(opts: ServiceCreateOpts) {
				sessionCreateCount++;
				// Simulate materializer: resolve plan service during session creation
				if (opts.supervisor) {
					await opts.supervisor.getOrStart(planDescriptor, opts);
				}
				let running = false;
				return {
					start() { running = true; return Promise.resolve(); },
					stop() { running = false; return Promise.resolve(); },
					health: () => Promise.resolve(running),
				};
			},
		});

		// Boot
		supervisor.register(sessionDescriptor);
		await supervisor.startAll({ cwd: process.cwd() });

		expect(sessionCreateCount).toBe(1);
		expect(planCreateCount).toBe(1);

		// Register hot-reload and get handle
		let rebuildHandle: { requestRebuild(): Promise<void> } | undefined;
		const hotReload = createHotReloadDescriptor({
			buildCommand: "echo build-ok",
			swap: async (name, opts) => supervisor.swap(name, opts),
			sessionServiceName: "session",
			cwd: process.cwd(),
			trace,
			onReady: (h) => { rebuildHandle = h; },
		});
		supervisor.register(hotReload);
		await supervisor.getOrStart(hotReload, { cwd: process.cwd() });
		expect(rebuildHandle).toBeDefined();

		// Trigger restart
		await rebuildHandle!.requestRebuild();

		// Session was re-created
		expect(sessionCreateCount).toBe(2);

		// Plan was stopped (by swap pre-cascade) then re-created (by session's getOrStart)
		expect(planStopCount).toBe(1);
		expect(planCreateCount).toBe(2);

		// Both are healthy
		const sessionHealth = await supervisor.get("session")?.health();
		const planHealth = await supervisor.get("plan")?.health();
		expect(sessionHealth).toBe(true);
		expect(planHealth).toBe(true);

		// Trace shows full lifecycle
		const phases = events.map(e => e.phase);
		expect(phases).toEqual(["build:start", "build:done", "swap:start", "swap:done", "complete"]);

		await supervisor.stopAll();
	});

	it("build failure leaves dependents untouched", async () => {
		const supervisor = new Supervisor();
		const { events, trace } = createTraceCollector();

		let planCreateCount = 0;
		const planDescriptor = defineManagedService({
			name: "plan",
			restart: "transient",
			shareable: false,
			dependsOn: ["session"],
			create() {
				planCreateCount++;
				return Promise.resolve({
					start() { return Promise.resolve(); },
					stop() { return Promise.resolve(); },
					health: () => Promise.resolve(true),
				});
			},
		});

		let sessionCreateCount = 0;
		const sessionDescriptor = defineManagedService({
			name: "session",
			restart: "permanent",
			shareable: true,
			async create(opts: ServiceCreateOpts) {
				sessionCreateCount++;
				if (opts.supervisor) await opts.supervisor.getOrStart(planDescriptor, opts);
				return {
					start() { return Promise.resolve(); },
					stop() { return Promise.resolve(); },
					health: () => Promise.resolve(true),
				};
			},
		});

		supervisor.register(sessionDescriptor);
		await supervisor.startAll({ cwd: process.cwd() });

		let rebuildHandle: { requestRebuild(): Promise<void> } | undefined;
		const hotReload = createHotReloadDescriptor({
			buildCommand: "exit 1",
			swap: async (name, opts) => supervisor.swap(name, opts),
			sessionServiceName: "session",
			cwd: process.cwd(),
			trace,
			onReady: (h) => { rebuildHandle = h; },
		});
		supervisor.register(hotReload);
		await supervisor.getOrStart(hotReload, { cwd: process.cwd() });

		await expect(rebuildHandle!.requestRebuild()).rejects.toThrow();

		// Nothing was touched
		expect(sessionCreateCount).toBe(1);
		expect(planCreateCount).toBe(1);
		expect(events.map(e => e.phase)).toEqual(["build:start", "error"]);

		await supervisor.stopAll();
	});
});
