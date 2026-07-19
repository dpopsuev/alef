/**
 * Restart E2E tests -- exercises the full reboot lifecycle through
 * the real Supervisor. Session create() calls getOrStart() for dependents,
 * simulating the real materializer path.
 */

import { describe, expect, it } from "vitest";
import { createBootloaderDescriptor, type BootEventListener } from "../src/bootloader.js";
import { defineManagedService } from "../src/managed-service.js";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import type { ServiceCreateOpts } from "@dpopsuev/alef-supervisor/lifecycle";

function createEventCollector() {
	const events: Array<{ phase: string }> = [];
	const onEvent: BootEventListener = (event) => events.push(event);
	return { events, onEvent };
}

describe("restart E2E", { tags: ["unit"] }, () => {
	it("dependents are re-created via getOrStart during session swap", async () => {
		const supervisor = new Supervisor();
		const { events, onEvent } = createEventCollector();

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

		let sessionCreateCount = 0;
		const sessionDescriptor = defineManagedService({
			name: "session",
			restart: "permanent",
			shareable: true,
			async create(opts: ServiceCreateOpts) {
				sessionCreateCount++;
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

		supervisor.register(sessionDescriptor);
		await supervisor.startAll({ cwd: process.cwd() });

		expect(sessionCreateCount).toBe(1);
		expect(planCreateCount).toBe(1);

		let rebootHandle: { reboot(): Promise<void> } | undefined;
		const bootloader = createBootloaderDescriptor({
			buildCommand: "echo build-ok",
			swap: async (name, opts) => supervisor.swap(name, opts),
			sessionServiceName: "session",
			cwd: process.cwd(),
			onEvent,
			onReady: (h) => { rebootHandle = h; },
		});
		supervisor.register(bootloader);
		await supervisor.getOrStart(bootloader, { cwd: process.cwd() });
		expect(rebootHandle).toBeDefined();

		await rebootHandle!.reboot();

		expect(sessionCreateCount).toBe(2);
		expect(planStopCount).toBe(1);
		expect(planCreateCount).toBe(2);

		const sessionHealth = await supervisor.get("session")?.health();
		const planHealth = await supervisor.get("plan")?.health();
		expect(sessionHealth).toBe(true);
		expect(planHealth).toBe(true);

		const phases = events.map(e => e.phase);
		expect(phases).toEqual(["build:start", "build:done", "swap:start", "swap:done", "complete"]);

		await supervisor.stopAll();
	});

	it("build failure leaves dependents untouched", async () => {
		const supervisor = new Supervisor();
		const { events, onEvent } = createEventCollector();

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

		let rebootHandle: { reboot(): Promise<void> } | undefined;
		const bootloader = createBootloaderDescriptor({
			buildCommand: "exit 1",
			swap: async (name, opts) => supervisor.swap(name, opts),
			sessionServiceName: "session",
			cwd: process.cwd(),
			onEvent,
			onReady: (h) => { rebootHandle = h; },
		});
		supervisor.register(bootloader);
		await supervisor.getOrStart(bootloader, { cwd: process.cwd() });

		await expect(rebootHandle!.reboot()).rejects.toThrow();

		expect(sessionCreateCount).toBe(1);
		expect(planCreateCount).toBe(1);
		expect(events.map(e => e.phase)).toEqual(["build:start", "error"]);

		await supervisor.stopAll();
	});
});
