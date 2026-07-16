import type { ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { defineManagedService } from "./managed-service.js";

/** Runtime task recorded by the scheduler service. */
export interface ScheduledTask {
	readonly id: string;
	readonly type: "defer" | "repeat";
	readonly intervalMs: number;
	readonly event: { type: string; payload: Record<string, unknown>; correlationId: string };
}

/** Managed-service surface for deferred and recurring event publication. */
export interface Scheduler {
	defer(delayMs: number, event: ScheduledTask["event"]): string;
	repeat(intervalMs: number, event: ScheduledTask["event"]): string;
	cancel(id: string): boolean;
	list(): readonly ScheduledTask[];
	setPublisher(fn: (event: ScheduledTask["event"]) => void): void;
}

let nextId = 0;

/** Build a `ServiceDescriptor` for the Foundry in-process scheduler. */
export function createSchedulerDescriptor(): ServiceDescriptor {
	return defineManagedService<Scheduler>({
		name: "scheduler",
		restart: "permanent",
		shareable: true,
		create(_opts: ServiceCreateOpts) {
			const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; task: ScheduledTask }>();
			let publishFn: ((event: ScheduledTask["event"]) => void) | undefined;

			const scheduler: Scheduler = {
				defer(delayMs, event) {
					const id = `sched-${++nextId}`;
					const task: ScheduledTask = { id, type: "defer", intervalMs: delayMs, event };
					const timer = setTimeout(() => {
						publishFn?.(event);
						timers.delete(id);
					}, delayMs);
					timers.set(id, { timer, task });
					return id;
				},

				repeat(intervalMs, event) {
					const id = `sched-${++nextId}`;
					const task: ScheduledTask = { id, type: "repeat", intervalMs, event };
					const timer = setInterval(() => {
						publishFn?.(event);
					}, intervalMs);
					timers.set(id, { timer, task });
					return id;
				},

				cancel(id) {
					const entry = timers.get(id);
					if (!entry) return false;
					if (entry.task.type === "repeat") clearInterval(entry.timer);
					else clearTimeout(entry.timer);
					timers.delete(id);
					return true;
				},

				list() {
					return [...timers.values()].map((entry) => entry.task);
				},

				setPublisher(fn: (event: ScheduledTask["event"]) => void) {
					publishFn = fn;
				},
			};

			return Promise.resolve({
				...scheduler,
				stop() {
					for (const { timer, task } of timers.values()) {
						if (task.type === "repeat") clearInterval(timer);
						else clearTimeout(timer);
					}
					timers.clear();
					return Promise.resolve();
				},
				health: () => Promise.resolve(true),
			});
		},
	});
}
