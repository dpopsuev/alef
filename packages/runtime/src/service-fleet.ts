import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog, McpOrgan } from "@dpopsuev/alef-kernel";

export type RestartPolicy = "permanent" | "transient" | "temporary";

export interface ServiceConfig {
	binary: string;
	args?: string[];
	env?: Record<string, string>;
	transport?: "stdio" | "http";
	httpUrl?: string;
	restart?: RestartPolicy;
	dependsOn?: string[];
	ingestURL?: string;
}

export interface FleetConfig {
	services: Record<string, ServiceConfig>;
}

interface ManagedService {
	name: string;
	config: ServiceConfig;
	organ: Organ;
	cleanup: () => void;
}

export class ServiceFleet {
	private readonly config: FleetConfig;
	private readonly managed = new Map<string, ManagedService>();
	private bootOrder: string[] = [];
	private started = false;

	constructor(config: FleetConfig) {
		this.config = config;
	}

	async start(nerve: Nerve): Promise<void> {
		if (this.started) throw new Error("ServiceFleet already started");
		this.started = true;

		this.bootOrder = topoSort(this.config.services);
		debugLog("fleet:start", { order: this.bootOrder });

		for (const name of this.bootOrder) {
			const cfg = this.config.services[name];
			const resolvedEnv = this.resolveEnv(name, cfg);
			const organ = await this.spawnService(name, cfg, resolvedEnv);
			const cleanup = organ.mount(nerve);

			this.managed.set(name, { name, config: cfg, organ, cleanup });

			nerve.sense.publish({
				type: "organ.loaded",
				correlationId: `fleet-${name}`,
				payload: {
					name,
					tools: organ.tools.map((t) => ({ name: t.name, description: t.description })),
				},
				isError: false,
			});

			debugLog("fleet:service:ready", { name, tools: organ.tools.length });
		}
	}

	async stop(): Promise<void> {
		const reversed = [...this.bootOrder].reverse();
		debugLog("fleet:stop", { order: reversed });

		for (const name of reversed) {
			const svc = this.managed.get(name);
			if (!svc) continue;

			svc.cleanup();
			if (svc.organ.close) {
				await svc.organ.close().catch((err: unknown) => {
					debugLog("fleet:service:close:error", { name, error: String(err) });
				});
			}
			this.managed.delete(name);
		}

		this.started = false;
	}

	get(name: string): Organ | undefined {
		return this.managed.get(name)?.organ;
	}

	tools(): readonly ToolDefinition[] {
		return [...this.managed.values()].flatMap((s) => [...s.organ.tools]);
	}

	names(): string[] {
		return [...this.managed.keys()];
	}

	private async spawnService(name: string, cfg: ServiceConfig, env?: Record<string, string>): Promise<Organ> {
		if (cfg.transport === "http" && cfg.httpUrl) {
			return McpOrgan.http(cfg.httpUrl, name);
		}
		const args = cfg.args ?? ["serve"];
		return McpOrgan.stdio(cfg.binary, args, name, env);
	}

	private resolveEnv(name: string, cfg: ServiceConfig): Record<string, string> | undefined {
		if (!cfg.ingestURL) return cfg.env;

		const dep = cfg.ingestURL;
		const depCfg = this.config.services[dep];
		if (!depCfg) return cfg.env;

		let ingestAddr: string;
		if (depCfg.transport === "http" && depCfg.httpUrl) {
			ingestAddr = `${depCfg.httpUrl}/api/v1/ingest`;
		} else {
			ingestAddr = "";
		}

		const envKey = `${name.toUpperCase()}_INGEST_URL`;
		return { ...cfg.env, [envKey]: ingestAddr };
	}
}

function topoSort(services: Record<string, ServiceConfig>): string[] {
	const sorted: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(name: string): void {
		if (visited.has(name)) return;
		if (visiting.has(name)) throw new Error(`Circular dependency: ${name}`);
		visiting.add(name);

		const deps = services[name]?.dependsOn ?? [];
		for (const dep of deps) {
			if (!(dep in services)) throw new Error(`Unknown dependency: ${dep} (required by ${name})`);
			visit(dep);
		}

		visiting.delete(name);
		visited.add(name);
		sorted.push(name);
	}

	for (const name of Object.keys(services)) {
		visit(name);
	}
	return sorted;
}
