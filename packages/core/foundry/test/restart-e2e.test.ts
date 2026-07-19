/**
 * Restart E2E test -- exercises the full hot-reload lifecycle through
 * the real Supervisor and FoundryRuntime. Asserts on trace events
 * (model state), not rendered output (tui-testing lexicon).
 *
 * Coverage: build -> swap -> cascade -> trace events -> service health
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import { defineManagedService } from "../src/managed-service.js";
import { createHotReloadDescriptor, type HotReloadTrace } from "../src/hot-reload.js";

describe("restart E2E", { tags: ["unit"] }, () => {
	/** Trace event collector -- wired like the session store would be. */
	function createTraceCollector() {
		const events: Array<{ phase: string; detail?: Record<string, unknown>; ts: number }> = [];
		const trace: HotReloadTrace = (phase, detail) => {
			events.push({ phase, detail, ts: Date.now() });
		};
		return { events, trace };
	}

	/** Minimal session service that tracks create/start/stop lifecycle. */
	function createSessionDescriptor() {
		let createCount = 0;
		let startCount = 0;
		let stopCount = 0;

		const descriptor = defineManagedService({
			name: "session",
			restart: "permanent",
			shareable: true,
			create() {
				createCount++;
				let running = false;
				return Promise.resolve({
					start() {
						startCount++;
						running = true;
						return Promise.resolve();
					},
					stop() {
						stopCount++;
						running = false;
						return Promise.resolve();
					},
					health: () => Promise.resolve(running),
				});
			},
		});

		return {
			descriptor,
			get createCount() {
				return createCount;
			},
			get startCount() {
				return startCount;
			},
			get stopCount() {
				return stopCount;
			},
		};
	}

	/** Dependent service that tracks its own lifecycle (like plan adapter). */
	function createDependentDescriptor(name: string) {
		let createCount = 0;
		let startCount = 0;
		let stopCount = 0;

		const descriptor = defineManagedService({
			name,
			restart: "transient",
			shareable: false,
			dependsOn: ["session"],
			create() {
				createCount++;
				let running = false;
				return Promise.resolve({
					start() {
						startCount++;
						running = true;
						return Promise.resolve();
					},
					stop() {
						stopCount++;
						running = false;
						return Promise.resolve();
					},
					health: () => Promise.resolve(running),
				});
			},
		});

		return {
			descriptor,
			get createCount() {
				return createCount;
			},
			get startCount() {
				return startCount;
			},
			get stopCount() {
				return stopCount;
			},
		};
	}

	it("full restart lifecycle: build -> swap session -> cascade dependents", async () => {
		const supervisor = new Supervisor();
		const { events, trace } = createTraceCollector();
		const session = createSessionDescriptor();
		const plan = createDependentDescriptor("plan");
		const skills = createDependentDescriptor("skills");

		supervisor.register(session.descriptor);
		supervisor.register(plan.descriptor);
		supervisor.register(skills.descriptor);

		// Boot: start all services
		await supervisor.startAll({ cwd: process.cwd() });
		expect(session.createCount).toBe(1);
		expect(session.startCount).toBe(1);
		expect(plan.createCount).toBe(1);
		expect(skills.createCount).toBe(1);

		// Register hot-reload with trace and onReady
		let rebuildHandle: { requestRebuild(): Promise<void> } | undefined;
		supervisor.register(
			createHotReloadDescriptor({
				buildCommand: "echo build-ok",
				swap: async (name, opts) => supervisor.swap(name, opts),
				sessionServiceName: "session",
				cwd: process.cwd(),
				trace,
				onReady: (h) => {
					rebuildHandle = h;
				},
			}),
		);
		await supervisor.startAll({ cwd: process.cwd() });
		expect(rebuildHandle).toBeDefined();

		// Trigger restart
		await rebuildHandle!.requestRebuild();

		// Assert trace events
		const phases = events.map((e) => e.phase);
		expect(phases).toEqual(["build:start", "build:done", "swap:start", "swap:done", "complete"]);

		// Assert session was re-created (swap creates new instance)
		expect(session.createCount).toBe(2);
		expect(session.startCount).toBe(2);
		expect(session.stopCount).toBe(1); // old instance stopped

		// Assert dependents were cascaded (plan and skills re-created)
		expect(plan.createCount).toBe(2);
		expect(plan.startCount).toBe(2);
		expect(plan.stopCount).toBe(1);
		expect(skills.createCount).toBe(2);
		expect(skills.startCount).toBe(2);
		expect(skills.stopCount).toBe(1);

		// Assert all services are healthy after restart
		for (const name of supervisor.names()) {
			const svc = supervisor.get(name);
			if (svc) {
				const healthy = await svc.health();
				expect(healthy, `${name} should be healthy`).toBe(true);
			}
		}

		// Assert elapsed times are positive
		for (const e of events) {
			if (e.detail && "elapsedMs" in e.detail) {
				expect(e.detail.elapsedMs).toBeGreaterThanOrEqual(0);
			}
		}

		await supervisor.stopAll();
	});

	it("restart with build failure: no swap, dependents untouched", async () => {
		const supervisor = new Supervisor();
		const { events, trace } = createTraceCollector();
		const session = createSessionDescriptor();
		const plan = createDependentDescriptor("plan");

		supervisor.register(session.descriptor);
		supervisor.register(plan.descriptor);
		await supervisor.startAll({ cwd: process.cwd() });

		let rebuildHandle: { requestRebuild(): Promise<void> } | undefined;
		supervisor.register(
			createHotReloadDescriptor({
				buildCommand: "exit 1",
				swap: async (name, opts) => supervisor.swap(name, opts),
				sessionServiceName: "session",
				cwd: process.cwd(),
				trace,
				onReady: (h) => {
					rebuildHandle = h;
				},
			}),
		);
		await supervisor.startAll({ cwd: process.cwd() });

		await expect(rebuildHandle!.requestRebuild()).rejects.toThrow();

		// Trace shows build:start then error
		expect(events.map((e) => e.phase)).toEqual(["build:start", "error"]);

		// Session was NOT swapped
		expect(session.createCount).toBe(1);
		expect(session.stopCount).toBe(0);

		// Dependents were NOT touched
		expect(plan.createCount).toBe(1);
		expect(plan.stopCount).toBe(0);

		// Services are still healthy
		const sessionHealth = await supervisor.get("session")?.health();
		expect(sessionHealth).toBe(true);

		await supervisor.stopAll();
	});

	it("second restart works after first restart", async () => {
		const supervisor = new Supervisor();
		const { events, trace } = createTraceCollector();
		const session = createSessionDescriptor();

		supervisor.register(session.descriptor);
		await supervisor.startAll({ cwd: process.cwd() });

		let rebuildHandle: { requestRebuild(): Promise<void> } | undefined;
		supervisor.register(
			createHotReloadDescriptor({
				buildCommand: "echo ok",
				swap: async (name, opts) => supervisor.swap(name, opts),
				sessionServiceName: "session",
				cwd: process.cwd(),
				trace,
				onReady: (h) => {
					rebuildHandle = h;
				},
			}),
		);
		await supervisor.startAll({ cwd: process.cwd() });

		// First restart
		await rebuildHandle!.requestRebuild();
		expect(session.createCount).toBe(2);

		// Second restart
		await rebuildHandle!.requestRebuild();
		expect(session.createCount).toBe(3);
		expect(session.stopCount).toBe(2);

		// All trace phases present for both restarts
		const completes = events.filter((e) => e.phase === "complete");
		expect(completes.length).toBe(2);

		await supervisor.stopAll();
	});
});
