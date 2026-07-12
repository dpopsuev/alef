import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor, ServiceRegistry } from "./lifecycle.js";

/**
 *
 */
export function isServiceDescriptor(v: unknown): v is ServiceDescriptor {
	return typeof v === "object" && v !== null && "name" in v && "create" in v && typeof (v as { create: unknown }).create === "function";
}

/**
 *
 */
export interface ServiceResolverOpts {
	cwd: string;
	logger?: AdapterLogger;
}

/**
 *
 */
export function createServiceResolver(
	supervisor: Supervisor,
): (service: unknown, opts: ServiceResolverOpts) => Promise<readonly Adapter[] | undefined> {
	return async (service, opts) => {
		if (!isServiceDescriptor(service)) return undefined;
		const svc = await supervisor.getOrStart(service, { cwd: opts.cwd, logger: opts.logger });
		return svc.adapters;
	};
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
// eslint-disable-next-line no-magic-numbers
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

interface RunningService {
	descriptor: ServiceDescriptor;
	instance: ManagedService;
	restartTimestamps: number[];
	healthTimer?: ReturnType<typeof setInterval>;
	restartInFlight?: boolean;
}

/**
 *
 */
function topoSort(descriptors: ServiceDescriptor[]): ServiceDescriptor[] {
	const byName = new Map(descriptors.map((d) => [d.name, d]));
	const visited = new Set<string>();
	const sorted: ServiceDescriptor[] = [];

	/**
	 *
	 */
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

/**
 *
 */
export class Supervisor implements ServiceRegistry {
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

	async stop(name: string): Promise<void> {
		const svc = this.running.get(name);
		if (!svc) return;
		if (svc.healthTimer) clearInterval(svc.healthTimer);
		await svc.instance.stop().catch(() => {});
		this.running.delete(name);
		this.descriptors.delete(name);
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

	async getOrStart(descriptor: ServiceDescriptor, opts: ServiceCreateOpts): Promise<ManagedService> {
		const existing = this.running.get(descriptor.name);
		if (existing && descriptor.shareable) return existing.instance;

		if (!this.descriptors.has(descriptor.name)) {
			this.register(descriptor);
		}

		if (!this.running.has(descriptor.name)) {
			await this.startService(descriptor, opts);
		}

		return this.running.get(descriptor.name)!.instance;
	}

	async swap(
		name: string,
		opts: ServiceCreateOpts,
		handoff?: (old: ManagedService, next: ManagedService) => Promise<void>,
	): Promise<void> {
		const entry = this.running.get(name);
		if (!entry) return;

		const enriched = { ...opts, supervisor: this as ServiceRegistry };
		const next = await entry.descriptor.create(enriched);
		try {
			await next.start();
		} catch (err) {
			await next.stop().catch(() => {});
			throw err;
		}

		if (handoff) await handoff(entry.instance, next);

		if (entry.healthTimer) clearInterval(entry.healthTimer);
		await entry.instance.stop().catch(() => {});

		entry.instance = next;
		entry.restartTimestamps = [];

		if (entry.descriptor.restart === "permanent") {
			entry.healthTimer = setInterval(() => {
				void this.checkHealth(entry, opts);
			}, HEALTH_CHECK_INTERVAL_MS);
		}
	}

	private async startService(descriptor: ServiceDescriptor, opts: ServiceCreateOpts): Promise<void> {
		const enriched = { ...opts, supervisor: this as ServiceRegistry };
		const instance = await descriptor.create(enriched);
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
		if (entry.restartInFlight) return;
		entry.restartInFlight = true;

		try {
			const healthy = await entry.instance.health().catch(() => false);
			if (healthy) return;

			const now = Date.now();
			entry.restartTimestamps = entry.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
			if (entry.restartTimestamps.length >= MAX_RESTARTS) {
				opts.logger?.error(
					{ service: entry.descriptor.name, restarts: entry.restartTimestamps.length },
					"Service health exhausted — restart budget exceeded",
				);
				return;
			}

			const attempt = entry.restartTimestamps.length;
			const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
			entry.restartTimestamps.push(now);

			await new Promise((r) => setTimeout(r, delay));
			await entry.instance.stop().catch(() => {});

			const enriched = { ...opts, supervisor: this as ServiceRegistry };
			const newInstance = await entry.descriptor.create(enriched);
			await newInstance.start();
			entry.instance = newInstance;
		} finally {
			entry.restartInFlight = false;
		}
	}
}
