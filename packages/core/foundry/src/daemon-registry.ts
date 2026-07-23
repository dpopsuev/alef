import type { ManagedService, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { FoundryStartOptions } from "./types.js";

/**
 * Structural duck-type of @dpopsuev/alef-storage's DaemonEntry. Not imported
 * directly: core/storage already depends on core/foundry (for the
 * ManagedService lifecycle contract its own storage service uses), so a
 * foundry -> storage import would create a circular package dependency.
 * Any object with these fields (the real DaemonEntry included) satisfies
 * this structurally.
 */
export interface DiscoverableDaemon {
	readonly sessionId: string;
	readonly pid: number;
	readonly host: string;
	readonly port: number;
	readonly cwd: string;
	readonly startedAt: number;
	readonly lastHeartbeat?: number;
}

/** Structural duck-type of the read/write subset of @dpopsuev/alef-storage's DaemonRegistry that Foundry needs. */
export interface DaemonRegistrySource {
	list(): Promise<DiscoverableDaemon[]>;
	unregister(sessionId: string): Promise<void>;
	prune(ttlMs?: number): Promise<number>;
}

/** Minimal host surface discoverDaemons needs \u2014 satisfied by FoundryRuntime/FoundryServiceHost. */
export interface DaemonDiscoveryHost {
	ensure(descriptor: ServiceDescriptor, opts?: FoundryStartOptions): Promise<ManagedService>;
}

/** Default staleness window: a few missed heartbeats at the CLI's typical heartbeat interval. */
const DEFAULT_STALE_MS = 60_000;

/** A daemon is alive when its last heartbeat (or start time, before any heartbeat lands) is within the staleness window. */
export function isDaemonAlive(entry: DiscoverableDaemon, staleMs: number = DEFAULT_STALE_MS): boolean {
	const lastSeen = entry.lastHeartbeat ?? entry.startedAt;
	return Date.now() - lastSeen < staleMs;
}

/**
 * Build a ManagedService wrapping ONE already-discovered sibling daemon.
 * Unlike every other ManagedService in this codebase, this one doesn't own
 * what it wraps \u2014 the daemon was started by a separate process invocation.
 * start() is a no-op (it's already running); stop() signals the real OS
 * process and removes it from the persistent registry; health() reflects
 * heartbeat freshness rather than a live function call.
 */
export function createDaemonServiceDescriptor(
	entry: DiscoverableDaemon,
	registry: DaemonRegistrySource,
	staleMs: number = DEFAULT_STALE_MS,
): ServiceDescriptor {
	return {
		name: entry.sessionId,
		restart: "temporary",
		shareable: false,
		create(): Promise<ManagedService> {
			return Promise.resolve({
				name: entry.sessionId,
				restart: "temporary",
				adapters: [],
				tools: [],
				start: () => Promise.resolve(),
				async stop() {
					try {
						process.kill(entry.pid, "SIGTERM");
					} catch {
						// Already gone \u2014 stopping a dead daemon is not an error.
					}
					await registry.unregister(entry.sessionId);
				},
				health: () => Promise.resolve(isDaemonAlive(entry, staleMs)),
			});
		},
	};
}

/**
 * Prune stale entries, then register every remaining sibling (excluding
 * `selfSessionId`, this process's own entry) as a ManagedService on `host` \u2014
 * so foundry.names()/get()/stopService() see sibling daemons the same way
 * they see any locally-owned service, with the underlying difference (kill a
 * PID vs. call an owned function) hidden inside the descriptor above.
 *
 * Returns the discovered siblings directly, for callers (e.g. `alef --list`)
 * that just need the data without a second lookup through the host.
 */
export async function discoverDaemons(
	host: DaemonDiscoveryHost,
	registry: DaemonRegistrySource,
	opts: { cwd: string; selfSessionId?: string; staleMs?: number },
): Promise<DiscoverableDaemon[]> {
	await registry.prune(opts.staleMs);
	const entries = await registry.list();
	const siblings = entries.filter((entry) => entry.sessionId !== opts.selfSessionId);

	for (const entry of siblings) {
		await host.ensure(createDaemonServiceDescriptor(entry, registry, opts.staleMs), { cwd: opts.cwd });
	}

	return siblings;
}
