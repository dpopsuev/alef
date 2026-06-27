import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "./lifecycle.js";

export interface ScheduledTask {
	readonly id: string;
	readonly type: "defer" | "repeat";
	readonly intervalMs: number;
	readonly event: { type: string; payload: Record<string, unknown>; correlationId: string };
}

export interface Scheduler {
	defer(delayMs: number, event: ScheduledTask["event"]): string;
	repeat(intervalMs: number, event: ScheduledTask["event"]): string;
	cancel(id: string): boolean;
	list(): readonly ScheduledTask[];
}

let nextId = 0;

export function createSchedulerDescriptor(): ServiceDescriptor {
	return {
		name: "scheduler",
		restart: "permanent",
		shareable: true,

		create(_opts: ServiceCreateOpts): Promise<ManagedService & Scheduler> {
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
					return [...timers.values()].map((e) => e.task);
				},
			};

			return Promise.resolve({
				name: "scheduler",
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				...scheduler,
				start: () => Promise.resolve(),
				stop() {
					for (const { timer, task } of timers.values()) {
						if (task.type === "repeat") clearInterval(timer);
						else clearTimeout(timer);
					}
					timers.clear();
					return Promise.resolve();
				},
				health: () => Promise.resolve(true),

				setPublisher(fn: (event: ScheduledTask["event"]) => void) {
					publishFn = fn;
				},
			});
		},
	};
}
