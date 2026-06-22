/**
 * Blueprint materializer — loads Adapter instances from a CompiledAgentDefinition.
 *
 * No per-adapter knowledge. No if-chains. No pre-registration.
 * Each adapter is loaded dynamically and must export createAdapter(opts).
 *
 * Resolution order per adapter entry:
 *   path  → jiti.import(resolvedPath)       — TypeScript file, no build step
 *   name  → import(@dpopsuev/alef-adapter-{name})  — convention-based
 *   name  → import(name)                    — treated as npm package specifier
 *
 * Factory convention:
 *   Each adapter module exports createAdapter(opts: AdapterFactoryOptions): Adapter.
 *   The materializer calls it with { cwd, actions, logger }. Unknown options
 *   are ignored — each adapter's factory handles only what it needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, AdapterLogger, Nerve, SensePublishInput } from "@dpopsuev/alef-kernel";
import { debugLog, extractToolCallId } from "@dpopsuev/alef-kernel";
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
 * Convention: "fs" → "@dpopsuev/alef-adapter-fs".
 *
 * In the monorepo, packages resolve via Node's workspace symlinks.
 * Published packages resolve from node_modules via npm.
 * Both use the same naming convention — no registry needed.
 */
function resolveAdapterPackage(name: string): string {
	return `@dpopsuev/alef-adapter-${name}`;
}

/** Common options passed to every adapter factory. */
export interface AdapterFactoryOptions {
	cwd: string;
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

/** Expected shape of an adapter module — must export createAdapter. */
interface AdapterModule {
	createAdapter: (opts: AdapterFactoryOptions) => Adapter | Promise<Adapter>;
}

function resolveFactory(mod: Record<string, unknown>): AdapterModule["createAdapter"] | undefined {
	if (typeof mod.createAdapter === "function") return mod.createAdapter as AdapterModule["createAdapter"];
	if (typeof mod.createOrgan === "function") return mod.createOrgan as AdapterModule["createAdapter"];
	return undefined;
}

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
}

export interface MaterializerResult {
	adapters: Adapter[];
	/** @deprecated Use adapters */
	organs: Adapter[];
	modelId: string | undefined;
}

// ---------------------------------------------------------------------------
// Permission wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an organ with a permission gate.
 *
 * Before any motor event reaches the organ's handler, the gate checks the
 * allowlist. If the tool is not permitted it publishes a sense error with the
 * matching toolCallId so waitForToolResult in reasoner resolves with an error
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
		mount(nerve: Nerve): () => void {
			const gatedNerve: Nerve = {
				...nerve,
				motor: {
					...nerve.motor,
					subscribe: (type, handler) => {
						if (type === "*") return nerve.motor.subscribe(type, handler);
						return nerve.motor.subscribe(type, (event) => {
							if (allowed.has(event.type)) {
								void handler(event);
								return;
							}
							const toolCallId = extractToolCallId(event.payload);
							nerve.sense.publish({
								type: event.type,
								payload: toolCallId !== undefined ? { toolCallId } : {},
								isError: true,
								errorMessage:
									`Permission denied: '${event.type}' is not in allowed_tools. ` +
									`Add it to permissions.allowed_tools in config.yaml to enable it.`,
								correlationId: event.correlationId,
							} satisfies SensePublishInput);
						});
					},
				},
			};
			return adapter.mount(gatedNerve);
		},
	};
}

export const DEFAULT_COMPILED_DEFINITION: CompiledAgentDefinition = loadAgentDefinition(
	resolve(dirname(fileURLToPath(import.meta.url)), "../default-blueprint.yaml"),
);

/** The canonical alef-coding-agent adapter set — matches blueprint.yaml in packages/alef-coding-agent. */
export const CODING_AGENT_BLUEPRINT: CompiledAgentDefinition = {
	name: "alef-coding-agent",
	organs: [
		{ name: "fs", actions: [], toolNames: [] },
		{ name: "shell", actions: [], toolNames: [] },
		{ name: "nodesh", actions: [], toolNames: [] },
		{ name: "code-intel", actions: [], toolNames: [] },
		{ name: "git", actions: [], toolNames: [] },
		{ name: "web", actions: [], toolNames: [] },
		{ name: "agent", actions: [], toolNames: [] },
		{ name: "factory", actions: [], toolNames: [] },
		{ name: "skills", actions: [], toolNames: [] },
	],
	model: undefined,
	children: [],
	surfaces: [],
	capabilities: { tools: [], orchestration: true },
	memory: { session: "memory", working: {} },
	policies: { appendSystemPrompt: [] },
	hooks: { extensions: [] },
};

/** Materialize the default coding agent adapter set for use in eval and test harnesses. */
export async function materializeDefaultAdapters(cwd: string) {
	const { adapters } = await materializeBlueprint(CODING_AGENT_BLUEPRINT, { cwd });
	return adapters;
}

/** Path to the user adapters config file. Read at call time so ALEF_PM_ROOT overrides work in tests. */
export function userAdaptersConfigPath(): string {
	const root = process.env.ALEF_PM_ROOT ?? join(homedir(), ".config", "alef");
	return join(root, "organs.yaml");
}

type AdapterEntry = string | { name: string; path?: string; actions?: string[] };

/**
 * Load user adapters config from ~/.config/alef/organs.yaml.
 * Returns null when the file does not exist (caller falls back to default).
 */
export function loadUserAdaptersConfig(): CompiledAgentDefinition["organs"] | null {
	const configPath = userAdaptersConfigPath();
	if (!existsSync(configPath)) return null;
	const text = readFileSync(configPath, "utf-8");
	const parsed = parseYaml(text) as unknown;
	if (!parsed || typeof parsed !== "object") return null;
	const rec = parsed as Record<string, unknown>;
	const entries = rec.adapters ?? rec.organs;
	if (!Array.isArray(entries)) return null;
	return (entries as AdapterEntry[]).map((entry) => {
		if (typeof entry === "string") {
			return { name: entry, actions: [], toolNames: [] };
		}
		return {
			name: entry.name,
			path: entry.path,
			actions: entry.actions ?? [],
			toolNames: [],
		};
	});
}

let _jiti: ReturnType<typeof createJiti> | undefined;
function getJiti(): ReturnType<typeof createJiti> {
	if (!_jiti) {
		_jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	}
	return _jiti;
}

async function loadAdapterModule(
	adapterDef: CompiledAgentDefinition["organs"][number],
	resolveExternalPath?: (name: string) => string | undefined,
): Promise<AdapterModule> {
	if (adapterDef.path) {
		const jitiMod = await getJiti().import(adapterDef.path);
		const mod = jitiMod as Record<string, unknown>;
		const factory = resolveFactory(mod);
		if (!factory) {
			throw new Error(
				`Adapter at '${adapterDef.path}' does not export createAdapter(opts). ` +
					`Export a function named createAdapter that returns an Adapter.`,
			);
		}
		return { createAdapter: factory };
	}

	const pmPath = resolveExternalPath?.(adapterDef.name);
	if (pmPath) {
		const jitiMod = await getJiti().import(pmPath);
		const mod = jitiMod as Record<string, unknown>;
		const factory = resolveFactory(mod);
		if (!factory) {
			throw new Error(`Adapter at '${pmPath}' (alef-pm managed) does not export createAdapter(opts).`);
		}
		return { createAdapter: factory };
	}
	const pkg = resolveAdapterPackage(adapterDef.name);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const rawMod = await import(pkg);
	const mod = rawMod as unknown as Record<string, unknown>;
	const factory = resolveFactory(mod);
	if (!factory) {
		throw new Error(
			`Adapter package '${pkg}' does not export createAdapter(opts). ` +
				`Add \`export { createYourAdapter as createAdapter } from "./organ.js"\` to its index.`,
		);
	}
	return { createAdapter: factory };
}

/**
 * Load a single organ from an absolute TypeScript file path.
 * Used by hot-reload (:reload) to swap an organ in-place without restart.
 */
export async function loadAdapterFromPath(
	path: string,
	opts: Pick<MaterializerOptions, "cwd" | "loggerFor" | "writableRoots">,
): Promise<Adapter> {
	const jitiMod = await getJiti().import(path);
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

export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const adapters: Adapter[] = [];

	for (const adapterDef of definition.organs) {
		if (["ai", "discourse", "symbols"].includes(adapterDef.name)) continue;

		const label = adapterDef.path ? adapterDef.path : resolveAdapterPackage(adapterDef.name);
		try {
			const mod = await loadAdapterModule(adapterDef, opts.resolveExternalPath);
			const adapter = await mod.createAdapter({
				cwd: opts.cwd,
				actions: adapterDef.actions.length > 0 ? adapterDef.actions : undefined,
				logger: opts.loggerFor?.(adapterDef.name),
				writableRoots: opts.writableRoots,
				blockedPatterns: adapterDef.blockedPatterns?.map((p) => new RegExp(p)),
			});
			const gated =
				opts.allowedTools && opts.allowedTools.length > 0
					? wrapWithPermissions(adapter, opts.allowedTools)
					: adapter;
			adapters.push(gated);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("does not export createAdapter") || msg.includes("does not export createOrgan")) {
				debugLog("blueprint:organ:skip", { organ: label, reason: msg });
			} else {
				throw new Error(`[blueprint] Failed to load organ '${label}': ${msg}`);
			}
		}
	}

	let modelId: string | undefined;
	if (definition.model) {
		modelId = `${definition.model.provider}/${definition.model.id}`;
	}

	return { adapters, organs: adapters, modelId };
}
