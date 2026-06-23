import type { Adapter, Bus, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog, McpAdapter } from "@dpopsuev/alef-kernel";

export type RestartPolicy = "permanent" | "transient" | "temporary";

export interface ToolServiceConfig {
	binary: string;
	args?: string[];
	env?: Record<string, string>;
	transport?: "stdio" | "http";
	httpUrl?: string;
	restart?: RestartPolicy;
	dependsOn?: string[];
	ingestURL?: string;
}

export interface SupervisorConfig {
	services: Record<string, ToolServiceConfig>;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000];

interface ManagedService {
	name: string;
	config: ToolServiceConfig;
	adapter: Adapter;
	cleanup: () => void;
	restartTimestamps: number[];
	healthTimer?: ReturnType<typeof setInterval>;
}

export class ToolSupervisor {
	private readonly config: SupervisorConfig;
	private readonly managed = new Map<string, ManagedService>();
	private bootOrder: string[] = [];
	private started = false;
	private nerve: Bus | null = null;

	constructor(config: SupervisorConfig) {
		this.config = config;
	}

	async start(nerve: Bus): Promise<void> {
		if (this.started) throw new Error("ToolSupervisor already started");
		this.started = true;
		this.nerve = nerve;

		this.bootOrder = topoSort(this.config.services);
		debugLog("fleet:start", { order: this.bootOrder });

		for (const name of this.bootOrder) {
			const cfg = this.config.services[name];
			await this.bootService(name, cfg, nerve);
		}
	}

	async stop(): Promise<void> {
		const reversed = [...this.bootOrder].reverse();
		debugLog("fleet:stop", { order: reversed });

		for (const name of reversed) {
			const svc = this.managed.get(name);
			if (!svc) continue;

			if (svc.healthTimer) clearInterval(svc.healthTimer);
			svc.cleanup();
			if (svc.adapter.close) {
				await svc.adapter.close().catch((err: unknown) => {
					debugLog("fleet:service:close:error", { name, error: String(err) });
				});
			}
			this.managed.delete(name);
		}

		this.started = false;
		this.nerve = null;
	}

	get(name: string): Adapter | undefined {
		return this.managed.get(name)?.adapter;
	}

	tools(): readonly ToolDefinition[] {
		return [...this.managed.values()].flatMap((s) => [...s.adapter.tools]);
	}

	names(): string[] {
		return [...this.managed.keys()];
	}

	private async bootService(name: string, cfg: ToolServiceConfig, nerve: Bus): Promise<void> {
		const resolvedEnv = this.resolveEnv(name, cfg);
		const adapter = await this.spawnService(name, cfg, resolvedEnv);
		const cleanup = adapter.mount(nerve);

		const svc: ManagedService = {
			name,
			config: cfg,
			adapter,
			cleanup,
			restartTimestamps: [],
		};

		if (cfg.restart === "permanent") {
			svc.healthTimer = setInterval(() => {
				void this.healthCheck(name);
			}, 30_000);
		}

		this.managed.set(name, svc);

		nerve.sense.publish({
			type: "organ.loaded",
			correlationId: `fleet-${name}`,
			payload: {
				name,
				tools: adapter.tools.map((t) => ({ name: t.name, description: t.description })),
			},
			isError: false,
		});

		debugLog("fleet:service:ready", { name, tools: adapter.tools.length });
	}

	private async healthCheck(name: string): Promise<void> {
		const svc = this.managed.get(name);
		if (!svc || !this.nerve) return;

		try {
			const adapter = svc.adapter as unknown as { client?: { ping?: () => Promise<void> } };
			if (typeof adapter.client?.ping === "function") {
				await adapter.client.ping();
			}
		} catch {
			debugLog("fleet:service:unhealthy", { name });
			await this.restartService(name);
		}
	}

	private async restartService(name: string): Promise<void> {
		const svc = this.managed.get(name);
		if (!svc || !this.nerve) return;

		const policy = svc.config.restart ?? "temporary";
		if (policy === "temporary") return;

		const now = Date.now();
		const recent = svc.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
		if (recent.length >= MAX_RESTARTS) {
			debugLog("fleet:service:restart:rate-limited", { name, restarts: recent.length });
			return;
		}

		svc.restartTimestamps = [...recent, now];
		const attempt = recent.length;
		const backoff = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];

		debugLog("fleet:service:restarting", { name, attempt: attempt + 1, backoffMs: backoff });

		svc.cleanup();
		if (svc.adapter.close) {
			await svc.adapter.close().catch(() => {});
		}

		await new Promise((r) => setTimeout(r, backoff));

		try {
			await this.bootService(name, svc.config, this.nerve);
			debugLog("fleet:service:restarted", { name });
		} catch (err: unknown) {
			debugLog("fleet:service:restart:failed", { name, error: String(err) });
		}
	}

	private async spawnService(name: string, cfg: ToolServiceConfig, env?: Record<string, string>): Promise<Adapter> {
		if (cfg.transport === "http" && cfg.httpUrl) {
			return McpAdapter.http(cfg.httpUrl, name);
		}
		const args = cfg.args ?? ["serve"];
		return McpAdapter.stdio(cfg.binary, args, name, env);
	}

	private resolveEnv(name: string, cfg: ToolServiceConfig): Record<string, string> | undefined {
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

function topoSort(services: Record<string, ToolServiceConfig>): string[] {
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
