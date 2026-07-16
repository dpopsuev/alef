/**
 * Scheduler service tests — defer, repeat, cancel, list, cleanup.
 */

import type { Scheduler } from "@dpopsuev/alef-foundry";
import { createSchedulerDescriptor } from "@dpopsuev/alef-foundry";
import type { ManagedService } from "@dpopsuev/alef-supervisor/lifecycle";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import { afterEach, describe, expect, it } from "vitest";

describe("Scheduler service", { tags: ["unit"] }, () => {
	const supervisors: Supervisor[] = [];

	afterEach(async () => {
		for (const s of supervisors.splice(0)) await s.stopAll().catch(() => {});
	});

	async function bootScheduler() {
		const supervisor = new Supervisor();
		supervisors.push(supervisor);
		supervisor.register(createSchedulerDescriptor());
		await supervisor.startAll({ cwd: "/tmp" });
		const svc = supervisor.get("scheduler") as ManagedService & Scheduler;
		return { supervisor, scheduler: svc };
	}

	it("defer fires once after delay", async () => {
		const { scheduler } = await bootScheduler();
		const events: string[] = [];

		scheduler.setPublisher((event) => events.push(event.type));
		scheduler.defer(50, { type: "test.deferred", payload: {}, correlationId: "t1" });

		await new Promise((r) => setTimeout(r, 100));
		expect(events).toEqual(["test.deferred"]);

		// Should not fire again
		await new Promise((r) => setTimeout(r, 100));
		expect(events).toHaveLength(1);
	});

	it("repeat fires multiple times", async () => {
		const { scheduler } = await bootScheduler();
		const events: string[] = [];

		scheduler.setPublisher((event) => events.push(event.type));
		const id = scheduler.repeat(30, { type: "test.recurring", payload: {}, correlationId: "t2" });

		await new Promise((r) => setTimeout(r, 120));
		scheduler.cancel(id);

		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events.every((e) => e === "test.recurring")).toBe(true);
	});

	it("cancel stops a scheduled task", async () => {
		const { scheduler } = await bootScheduler();
		const events: string[] = [];

		scheduler.setPublisher((event) => events.push(event.type));
		const id = scheduler.defer(50, { type: "test.cancelled", payload: {}, correlationId: "t3" });

		expect(scheduler.cancel(id)).toBe(true);
		expect(scheduler.cancel(id)).toBe(false); // already cancelled

		await new Promise((r) => setTimeout(r, 100));
		expect(events).toHaveLength(0);
	});

	it("list returns active tasks", async () => {
		const { scheduler } = await bootScheduler();

		const id1 = scheduler.defer(1000, { type: "a", payload: {}, correlationId: "x" });
		const id2 = scheduler.repeat(1000, { type: "b", payload: {}, correlationId: "y" });

		const tasks = scheduler.list();
		expect(tasks).toHaveLength(2);
		expect(tasks.map((t) => t.id)).toContain(id1);
		expect(tasks.map((t) => t.id)).toContain(id2);

		scheduler.cancel(id1);
		expect(scheduler.list()).toHaveLength(1);

		scheduler.cancel(id2);
		expect(scheduler.list()).toHaveLength(0);
	});

	it("stop clears all timers", async () => {
		const { supervisor, scheduler } = await bootScheduler();
		const events: string[] = [];

		scheduler.setPublisher((event) => events.push(event.type));
		scheduler.defer(50, { type: "test.stopped", payload: {}, correlationId: "t4" });
		scheduler.repeat(50, { type: "test.stopped2", payload: {}, correlationId: "t5" });

		await supervisor.stopAll();

		await new Promise((r) => setTimeout(r, 100));
		expect(events).toHaveLength(0);
		expect(scheduler.list()).toHaveLength(0);
	});
});
