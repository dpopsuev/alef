import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "./lifecycle.js";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

interface RunningService {
	descriptor: ServiceDescriptor;
	instance: ManagedService;
	restartTimestamps: number[];
	healthTimer?: ReturnType<typeof setInterval>;
}

function topoSort(descriptors: ServiceDescriptor[]): ServiceDescriptor[] {
	const byName = new Map(descriptors.map((d) => [d.name, d]));
	const visited = new Set<string>();
	const sorted: ServiceDescriptor[] = [];

	function visit(name: string, stack: Set<string>): void {
		if (visited.has(name)) return;
		if (stack.has(name)) throw new Error(`Circular dependency: ${[...stack, name].join(" → ")}`);
		const desc = byName.get(name);
		if (!desc) return;
		stack.add(name);
		for (const dep of desc.dependsOn ?? []) visit(dep, stack);
		stack.delete(name);
		visited.add(name);
		sorted.push(desc);
	}

	for (const d of descriptors) visit(d.name, new Set());
	return sorted;
}

export class Supervisor {
	private readonly descriptors = new Map<string, ServiceDescriptor>();
	private readonly running = new Map<string, RunningService>();
	private bootOrder: string[] = [];

	register(descriptor: ServiceDescriptor): void {
		this.descriptors.set(descriptor.name, descriptor);
	}

	async startAll(opts: ServiceCreateOpts): Promise<void> {
		const sorted = topoSort([...this.descriptors.values()]);
		this.bootOrder = sorted.map((d) => d.name);

		for (const descriptor of sorted) {
			if (this.running.has(descriptor.name)) continue;
			await this.startService(descriptor, opts);
		}
	}

	async stopAll(): Promise<void> {
		const reversed = [...this.bootOrder].reverse();
		for (const name of reversed) {
			const svc = this.running.get(name);
			if (!svc) continue;
			if (svc.healthTimer) clearInterval(svc.healthTimer);
			await svc.instance.stop().catch(() => {});
			this.running.delete(name);
		}
		this.bootOrder = [];
	}

	get(name: string): ManagedService | undefined {
		return this.running.get(name)?.instance;
	}

	strategy(name: string): ExecutionStrategy | undefined {
		return this.running.get(name)?.instance.strategy;
	}

	adapters(): Adapter[] {
		const result: Adapter[] = [];
		for (const svc of this.running.values()) {
			result.push(...svc.instance.adapters);
		}
		return result;
	}

	tools(): ToolDefinition[] {
		const result: ToolDefinition[] = [];
		for (const svc of this.running.values()) {
			result.push(...svc.instance.tools);
		}
		return result;
	}

	names(): string[] {
		return [...this.running.keys()];
	}

	private async startService(descriptor: ServiceDescriptor, opts: ServiceCreateOpts): Promise<void> {
		const instance = await descriptor.create(opts);
		await instance.start();

		const entry: RunningService = {
			descriptor,
			instance,
			restartTimestamps: [],
		};

		if (descriptor.restart === "permanent") {
			entry.healthTimer = setInterval(() => {
				void this.checkHealth(entry, opts);
			}, HEALTH_CHECK_INTERVAL_MS);
		}

		this.running.set(descriptor.name, entry);
	}

	private async checkHealth(entry: RunningService, opts: ServiceCreateOpts): Promise<void> {
		const healthy = await entry.instance.health().catch(() => false);
		if (healthy) return;

		const now = Date.now();
		entry.restartTimestamps = entry.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
		if (entry.restartTimestamps.length >= MAX_RESTARTS) return;

		const attempt = entry.restartTimestamps.length;
		const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
		entry.restartTimestamps.push(now);

		await new Promise((r) => setTimeout(r, delay));
		await entry.instance.stop().catch(() => {});

		const newInstance = await entry.descriptor.create(opts);
		await newInstance.start();
		entry.instance = newInstance;
	}
}
