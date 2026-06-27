/**
 * Supervisor-based entrypoint — one Supervisor, everything is a service.
 *
 * Boot sequence mirrors OpenBSD rc(8):
 *   1. Supervisor starts (init)
 *   2. Storage service starts (DB open)
 *   3. Scheduler starts (timer registry)
 *   4. Package Manager starts (discovers + registers tool services)
 *   5. Tool services start (topo-sorted by dependsOn)
 *   6. Agent service starts (LLM loop, mounts shared adapters)
 *
 * This coexists with cli/main.ts during migration (strangler fig).
 */

import { service as storageService } from "@dpopsuev/alef-storage/service";
import { createPackageManagerDescriptor, type DiscoveredService } from "@dpopsuev/alef-supervisor/package-manager";
import { createSchedulerDescriptor } from "@dpopsuev/alef-supervisor/scheduler";
import { isServiceDescriptor, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export interface BootOptions {
	cwd: string;
	toolNames?: string[];
}

function resolveAdapterPackage(name: string): string {
	return `@dpopsuev/alef-tool-${name}`;
}

async function discoverTools(_cwd: string, toolNames?: string[]): Promise<readonly DiscoveredService[]> {
	const names = toolNames ?? ["fs", "shell", "web", "code-intel", "skills"];
	const services: DiscoveredService[] = [];

	for (const name of names) {
		try {
			const pkg = resolveAdapterPackage(name);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const mod = await import(pkg);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (isServiceDescriptor(mod.service)) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
				services.push({ name, descriptor: mod.service });
			}
		} catch {
			// Tool not installed — skip
		}
	}

	return services;
}

export async function boot(opts: BootOptions): Promise<Supervisor> {
	const supervisor = new Supervisor();

	supervisor.register(storageService);
	supervisor.register(createSchedulerDescriptor());
	supervisor.register(
		createPackageManagerDescriptor({
			discover: (cwd) => discoverTools(cwd, opts.toolNames),
		}),
	);

	await supervisor.startAll({ cwd: opts.cwd });

	return supervisor;
}

export async function shutdown(supervisor: Supervisor): Promise<void> {
	await supervisor.stopAll();
}
