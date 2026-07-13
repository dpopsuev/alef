/**
 * Blueprint materializer — loads Adapter instances from a CompiledAgentDefinition.
 *
 * No per-adapter knowledge. No if-chains. No pre-registration.
 * Each adapter is loaded dynamically and must export createAdapter(opts).
 *
 * Resolution order per adapter entry:
 *   path  → jiti.import(resolvedPath)       — TypeScript file, no build step
 *   name  → import(@dpopsuev/alef-tool-{name})  — convention-based
 *   name  → import(name)                    — treated as npm package specifier
 *
 * Factory convention:
 *   Each adapter module exports createAdapter(opts: AdapterFactoryOptions): Adapter.
 *   The materializer calls it with { cwd, actions, logger }. Unknown options
 *   are ignored — each adapter's factory handles only what it needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import { type Bus, type EventInput, extractToolCallId } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import { loadAgentDefinition } from "./blueprints.js";
import type { CompiledAgentDefinition } from "./types.js";

/**
 * Short alias → npm package for adapters shipped with Alef.
 * Lives here — not in blueprint types — because the materializer is the
 * composition root that knows what it ships. Blueprint has zero adapter knowledge.
 * Add a new adapter here only; blueprint needs no change.
 */
/**
 * Resolve a short adapter name to a package specifier.
 * Convention: "fs" → "@dpopsuev/alef-tool-fs".
 *
 * In the monorepo, packages resolve via Node's workspace symlinks.
 * Published packages resolve from node_modules via npm.
 * Both use the same naming convention — no registry needed.
 */
function resolveAdapterPackage(name: string): string {
	return `@dpopsuev/alef-tool-${name}`;
}

/** Common options passed to every adapter factory. */
export interface AdapterFactoryOptions {
	cwd: string;
	sessionDir?: string;
	actions?: string[];
	logger?: AdapterLogger;
	/**
	 * OCAP grant — directories the adapter is allowed to access.
	 * Undefined = unrestricted (no path guard). Populated = enforce guard.
	 * Resolved from config.security.writable_roots by the materializer.
	 */
	writableRoots?: readonly string[];
	/** Shell command patterns to block. Passed through to adapter-shell's blockedPatterns. */
	blockedPatterns?: readonly RegExp[];
}

/** Expected shape of a tool module — must export createAdapter. */
export interface ToolModule {
	createAdapter: (opts: AdapterFactoryOptions) => Adapter | Promise<Adapter>;
}

interface ResolvedModule {
	createAdapter: ToolModule["createAdapter"];
	service?: unknown;
}

/**
 *
 */
function resolveFactory(mod: Record<string, unknown>): ToolModule["createAdapter"] | undefined {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded by typeof check
	if (typeof mod.createAdapter === "function") return mod.createAdapter as ToolModule["createAdapter"];
	return undefined;
}

/**
 *
 */
function resolveServiceExport(mod: Record<string, unknown>): unknown | undefined {
	if (mod.service && typeof mod.service === "object") return mod.service;
	return undefined;
}

/**
 *
 */
export interface MaterializerOptions {
	cwd: string;
	loggerFor?: (adapterName: string) => AdapterLogger;
	/**
	 * Tool event types the agent is permitted to call.
	 * "*" = allow all (yolo). Omit = no gate applied.
	 * Source: config.yaml permissions.allowed_tools.
	 */
	allowedTools?: string[];
	/**
	 * Resolve an external adapter path by name (e.g. from alef-pm managed node_modules).
	 * When omitted, only built-in aliases and npm package specifiers are resolved.
	 * Injected by the runner to decouple alef-pm from the materializer.
	 */
	resolveExternalPath?: (name: string) => string | undefined;
	/**
	 * OCAP grant — directories adapters are allowed to access.
	 * Undefined = unrestricted. Populated = enforce path guard.
	 * Source: config.yaml security.writable_roots (after placeholder resolution).
	 */
	writableRoots?: readonly string[];
	sessionDir?: string;
	/**
	 * Resolve adapters through a service supervisor instead of createAdapter().
	 * When provided, the materializer passes the module's `service` export (opaque)
	 * and factory options. Return adapters to use them; return undefined to fall
	 * through to createAdapter().
	 */
	resolveService?: (service: unknown, opts: AdapterFactoryOptions) => Promise<readonly Adapter[] | undefined>;
}

/**
 *
 */
export interface MaterializerResult {
	adapters: Adapter[];
	modelId: string | undefined;
}

// ---------------------------------------------------------------------------
// Permission wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an adapter with a permission gate.
 *
 * Before any command event reaches the adapter's handler, the gate checks the
 * allowlist. If the tool is not permitted it publishes an event error with the
 * matching toolCallId so waitForToolResult in the reasoner resolves with an error
 * the LLM can read, rather than hanging.
 *
 * allowedTools format:
 *   "*"         — allow everything (yolo mode)
 *   "fs.read"   — exact tool event type
 *   (empty/[])  — deny all (not useful in practice)
 */
export function wrapWithPermissions(adapter: Adapter, allowedTools: string[]): Adapter {
	if (allowedTools.includes("*")) return adapter; // yolo — bypass
	const allowed = new Set(allowedTools);

	return {
		...adapter,
		mount(bus: Bus): () => void {
			const gatedBus: Bus = {
				...bus,
				command: {
					...bus.command,
					subscribe: (type, handler) => {
						if (type === "*") return bus.command.subscribe(type, handler);
						return bus.command.subscribe(type, (event) => {
							if (allowed.has(event.type)) {
								void handler(event);
								return;
							}
							const toolCallId = extractToolCallId(event.payload);
							bus.event.publish({
								type: event.type,
								payload: toolCallId !== undefined ? { toolCallId } : {},
								isError: true,
								errorMessage:
									`Permission denied: '${event.type}' is not in allowed_tools. ` +
									`Add it to permissions.allowed_tools in config.yaml to enable it.`,
								correlationId: event.correlationId,
							} satisfies EventInput);
						});
					},
				},
			};
			return adapter.mount(gatedBus);
		},
	};
}

export const DEFAULT_COMPILED_DEFINITION: CompiledAgentDefinition = loadAgentDefinition(
	resolve(dirname(fileURLToPath(import.meta.url)), "../default-blueprint.yaml"),
);

/**
 * Resolve the published coding-agent SBOM YAML (package export ./blueprint).
 * Falls back to default-blueprint.yaml when the profile package is unavailable.
 */
export function resolveCodingBlueprintPath(): string {
	try {
		const require = createRequire(import.meta.url);
		return require.resolve("@dpopsuev/alef-coding-agent/blueprint");
	} catch {
		return resolve(dirname(fileURLToPath(import.meta.url)), "../default-blueprint.yaml");
	}
}

/** Canonical alef-coding-agent adapter set — loaded from the profile SBOM YAML. */
export const CODING_AGENT_BLUEPRINT: CompiledAgentDefinition = loadAgentDefinition(resolveCodingBlueprintPath());

/** Materialize the default coding agent adapter set for use in eval and test harnesses. */
export async function materializeDefaultAdapters(cwd: string) {
	const { adapters } = await materializeBlueprint(CODING_AGENT_BLUEPRINT, { cwd });
	return adapters;
}

/** Path to the user adapters config file. Read at call time so ALEF_PM_ROOT overrides work in tests. */
export function userAdaptersConfigPath(): string {
	const root = process.env.ALEF_PM_ROOT ?? join(homedir(), ".config", "alef");
	return join(root, "adapters.yaml");
}

type AdapterEntry = string | { name: string; path?: string; actions?: string[] };

/**
 * Load user adapters config from ~/.config/alef/adapters.yaml.
 * Returns null when the file does not exist (caller falls back to default).
 */
export function loadUserAdaptersConfig(): CompiledAgentDefinition["adapters"] | null {
	const effectivePath = resolveAdaptersConfigPath();
	if (!effectivePath) return null;

	const parsed = parseYaml(readFileSync(effectivePath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object") return null;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof/null check above
	const rec = parsed as Record<string, unknown>;
	const entries = rec.adapters;
	if (!Array.isArray(entries)) return null;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- entries validated by Array.isArray guard
	return (entries as AdapterEntry[]).map(normalizeAdapterEntry);
}

/** Resolve the path to the adapters config file. */
function resolveAdaptersConfigPath(): string | null {
	const configPath = userAdaptersConfigPath();
	if (existsSync(configPath)) return configPath;
	return null;
}

/** Normalize a raw adapter entry (string or object) into a full adapter definition. */
function normalizeAdapterEntry(entry: AdapterEntry): CompiledAgentDefinition["adapters"][number] {
	if (typeof entry === "string") {
		return { name: entry, actions: [], toolNames: [] };
	}
	return {
		name: entry.name,
		path: entry.path,
		actions: entry.actions ?? [],
		toolNames: [],
	};
}

let _jiti: ReturnType<typeof createJiti> | undefined;
/**
 *
 */
function getJiti(): ReturnType<typeof createJiti> {
	_jiti ??= createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	return _jiti;
}

/**
 *
 */
async function loadAdapterModule(
	adapterDef: CompiledAgentDefinition["adapters"][number],
	resolveExternalPath?: (name: string) => string | undefined,
): Promise<ResolvedModule> {
	if (adapterDef.path) {
		const jitiMod = await getJiti().import(adapterDef.path);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jiti returns unknown module shape
		const mod = jitiMod as Record<string, unknown>;
		const factory = resolveFactory(mod);
		if (!factory) {
			throw new Error(
				`Adapter at '${adapterDef.path}' does not export createAdapter(opts). ` +
					`Export a function named createAdapter that returns an Adapter.`,
			);
		}
		return { createAdapter: factory, service: resolveServiceExport(mod) };
	}

	const pmPath = resolveExternalPath?.(adapterDef.name);
	if (pmPath) {
		const jitiMod = await getJiti().import(pmPath);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jiti returns unknown module shape
		const mod = jitiMod as Record<string, unknown>;
		const factory = resolveFactory(mod);
		if (!factory) {
			throw new Error(`Adapter at '${pmPath}' (alef-pm managed) does not export createAdapter(opts).`);
		}
		return { createAdapter: factory, service: resolveServiceExport(mod) };
	}
	const pkg = resolveAdapterPackage(adapterDef.name);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const rawMod = await import(pkg);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic import returns unknown module shape
	const mod = rawMod as unknown as Record<string, unknown>;
	const factory = resolveFactory(mod);
	if (!factory) {
		throw new Error(
			`Adapter package '${pkg}' does not export createAdapter(opts). ` +
				`Add \`export { createYourAdapter as createAdapter } from "./adapter.js"\` to its index.`,
		);
	}
	return { createAdapter: factory, service: resolveServiceExport(mod) };
}

/**
 * Load a single adapter from an absolute TypeScript file path.
 * Used by hot-reload (:reload) to swap an adapter in-place without restart.
 */
export async function loadAdapterFromPath(
	path: string,
	opts: Pick<MaterializerOptions, "cwd" | "loggerFor" | "writableRoots">,
): Promise<Adapter> {
	const jitiMod = await getJiti().import(path);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jiti returns unknown module shape
	const mod = jitiMod as Record<string, unknown>;
	const factory = resolveFactory(mod);
	if (!factory) {
		throw new Error(`Adapter at '${path}' does not export createAdapter(opts).`);
	}
	return await factory({
		cwd: opts.cwd,
		logger: opts.loggerFor?.(path),
		writableRoots: opts.writableRoots,
	});
}

/** Apply the permission gate when an allowlist is active, pass through otherwise. */
function applyPermissionGate(adapter: Adapter, allowedTools: string[] | undefined): Adapter {
	if (!allowedTools || allowedTools.length === 0) return adapter;
	return wrapWithPermissions(adapter, allowedTools);
}

/** Resolve adapters from a loaded module — either via service supervisor or createAdapter(). */
async function resolveAdaptersForEntry(
	mod: ResolvedModule,
	factoryOpts: AdapterFactoryOptions,
	opts: MaterializerOptions,
): Promise<readonly Adapter[]> {
	if (mod.service && opts.resolveService) {
		const supervised = await opts.resolveService(mod.service, factoryOpts);
		if (supervised) return supervised;
	}
	return [await mod.createAdapter(factoryOpts)];
}

/**
 *
 */
export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const adapters: Adapter[] = [];

	for (const adapterDef of definition.adapters) {
		if (["ai", "discourse", "symbols"].includes(adapterDef.name)) continue;

		const label = adapterDef.path ?? resolveAdapterPackage(adapterDef.name);
		try {
			const mod = await loadAdapterModule(adapterDef, opts.resolveExternalPath);
			const factoryOpts: AdapterFactoryOptions = {
				cwd: opts.cwd,
				sessionDir: opts.sessionDir,
				actions: adapterDef.actions.length > 0 ? adapterDef.actions : undefined,
				logger: opts.loggerFor?.(adapterDef.name),
				writableRoots: opts.writableRoots,
				blockedPatterns: adapterDef.blockedPatterns?.map((p) => new RegExp(p)),
			};

			const resolved = await resolveAdaptersForEntry(mod, factoryOpts, opts);
			for (const adapter of resolved) {
				adapters.push(applyPermissionGate(adapter, opts.allowedTools));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("does not export createAdapter")) {
				traceEvent("blueprint:adapter:skip", { adapter: label, reason: msg });
			} else {
				throw new Error(`[blueprint] Failed to load adapter '${label}': ${msg}`);
			}
		}
	}

	const modelId = definition.model ? `${definition.model.provider}/${definition.model.id}` : undefined;

	return { adapters, modelId };
}
