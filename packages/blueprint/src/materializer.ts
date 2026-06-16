/**
 * Blueprint materializer — loads Organ instances from a CompiledAgentDefinition.
 *
 * No per-organ knowledge. No if-chains. No pre-registration.
 * Each organ is loaded dynamically and must export createOrgan(opts).
 *
 * Resolution order per organ entry:
 *   path  → jiti.import(resolvedPath)       — TypeScript file, no build step
 *   name  → import(@dpopsuev/alef-organ-{name})  — convention-based
 *   name  → import(name)                    — treated as npm package specifier
 *
 * Factory convention:
 *   Each organ module exports createOrgan(opts: OrganFactoryOptions): Organ.
 *   The materializer calls it with { cwd, actions, logger }. Unknown options
 *   are ignored — each organ's factory handles only what it needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Nerve, Organ, OrganLogger, SensePublishInput } from "@dpopsuev/alef-kernel";
import { extractToolCallId } from "@dpopsuev/alef-kernel";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import type { CompiledAgentDefinition } from "./types.js";

/**
 * Short alias → npm package for organs shipped with Alef.
 * Lives here — not in blueprint types — because the materializer is the
 * composition root that knows what it ships. Blueprint has zero organ knowledge.
 * Add a new organ here only; blueprint needs no change.
 */
/**
 * Resolve a short organ name to a package specifier.
 * Convention: "fs" → "@dpopsuev/alef-organ-fs".
 *
 * In the monorepo, packages resolve via Node's workspace symlinks.
 * Published packages resolve from node_modules via npm.
 * Both use the same naming convention — no registry needed.
 */
function resolveOrganPackage(name: string): string {
	return `@dpopsuev/alef-organ-${name}`;
}

/** Common options passed to every organ factory. */
export interface OrganFactoryOptions {
	cwd: string;
	actions?: string[];
	logger?: OrganLogger;
	/**
	 * OCAP grant — directories the organ is allowed to access.
	 * Undefined = unrestricted (no path guard). Populated = enforce guard.
	 * Resolved from config.security.writable_roots by the materializer.
	 */
	writableRoots?: readonly string[];
}

/** Expected shape of an organ module — must export createOrgan. */
interface OrganModule {
	createOrgan: (opts: OrganFactoryOptions) => Organ | Promise<Organ>;
}

export interface MaterializerOptions {
	cwd: string;
	loggerFor?: (organName: string) => OrganLogger;
	/**
	 * Tool event types the agent is permitted to call.
	 * "*" = allow all (yolo). Omit = no gate applied.
	 * Source: config.yaml permissions.allowed_tools.
	 */
	allowedTools?: string[];
	/**
	 * Resolve an external organ path by name (e.g. from alef-pm managed node_modules).
	 * When omitted, only built-in aliases and npm package specifiers are resolved.
	 * Injected by the runner to decouple alef-pm from the materializer.
	 */
	resolveExternalPath?: (name: string) => string | undefined;
	/**
	 * OCAP grant — directories organs are allowed to access.
	 * Undefined = unrestricted. Populated = enforce path guard.
	 * Source: config.yaml security.writable_roots (after placeholder resolution).
	 */
	writableRoots?: readonly string[];
}

export interface MaterializerResult {
	organs: Organ[];
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
 * matching toolCallId so waitForToolResult in organ-llm resolves with an error
 * the LLM can read, rather than hanging.
 *
 * allowedTools format:
 *   "*"         — allow everything (yolo mode)
 *   "fs.read"   — exact tool event type
 *   (empty/[])  — deny all (not useful in practice)
 */
export function wrapWithPermissions(organ: Organ, allowedTools: string[]): Organ {
	if (allowedTools.includes("*")) return organ; // yolo — bypass
	const allowed = new Set(allowedTools);

	return {
		...organ,
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
			return organ.mount(gatedNerve);
		},
	};
}

export const DEFAULT_COMPILED_DEFINITION: CompiledAgentDefinition = {
	name: "default",
	organs: [
		{ name: "fs", actions: [], toolNames: [] },
		{ name: "shell", actions: [], toolNames: [] },
		{ name: "nodesh", actions: [], toolNames: [] },
		{ name: "web", actions: [], toolNames: [] },
	],
	model: undefined,
	children: [],
	surfaces: [],
	capabilities: { tools: [], orchestration: true },
	memory: { session: "memory", working: {} },
	policies: { appendSystemPrompt: [] },
	hooks: { extensions: [] },
};

/** The canonical alef-coding-agent organ set — matches blueprint.yaml in packages/alef-coding-agent. */
export const CODING_AGENT_BLUEPRINT: CompiledAgentDefinition = {
	name: "alef-coding-agent",
	organs: [
		{ name: "fs", actions: [], toolNames: [] },
		{ name: "shell", actions: [], toolNames: [] },
		{ name: "nodesh", actions: [], toolNames: [] },
		{ name: "lector", actions: [], toolNames: [] },
		{ name: "web", actions: [], toolNames: [] },
		{ name: "agent", actions: [], toolNames: [] },
		{ name: "cache", actions: [], toolNames: [] },
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

/** Materialize the default coding agent organ set for use in eval and test harnesses. */
export async function materializeDefaultOrgans(cwd: string) {
	const { organs } = await materializeBlueprint(CODING_AGENT_BLUEPRINT, { cwd });
	return organs;
}

/** Path to the user organs config file. Read at call time so ALEF_PM_ROOT overrides work in tests. */
export function userOrgansConfigPath(): string {
	const root = process.env.ALEF_PM_ROOT ?? join(homedir(), ".config", "alef");
	return join(root, "organs.yaml");
}

type OrganEntry = string | { name: string; path?: string; actions?: string[] };

/**
 * Load user organs config from ~/.config/alef/organs.yaml.
 * Returns null when the file does not exist (caller falls back to default).
 */
export function loadUserOrgansConfig(): CompiledAgentDefinition["organs"] | null {
	const configPath = userOrgansConfigPath();
	if (!existsSync(configPath)) return null;
	const text = readFileSync(configPath, "utf-8");
	const parsed = parseYaml(text) as unknown;
	if (!parsed || typeof parsed !== "object" || !("organs" in parsed)) return null;
	const rec = parsed as Record<string, unknown>;
	if (!Array.isArray(rec.organs)) return null;
	return (rec.organs as OrganEntry[]).map((entry) => {
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

async function loadOrganModule(
	organDef: CompiledAgentDefinition["organs"][number],
	resolveExternalPath?: (name: string) => string | undefined,
): Promise<OrganModule> {
	if (organDef.path) {
		const jitiMod = await getJiti().import(organDef.path);
		const mod = jitiMod as Record<string, unknown>;
		if (typeof mod.createOrgan !== "function") {
			throw new Error(
				`Organ at '${organDef.path}' does not export createOrgan(opts). ` +
					`Export a function named createOrgan that returns an Organ.`,
			);
		}
		return mod as unknown as OrganModule;
	}

	const pmPath = resolveExternalPath?.(organDef.name);
	if (pmPath) {
		const jitiMod = await getJiti().import(pmPath);
		const mod = jitiMod as Record<string, unknown>;
		if (typeof mod.createOrgan !== "function") {
			throw new Error(`Organ at '${pmPath}' (alef-pm managed) does not export createOrgan(opts).`);
		}
		return mod as unknown as OrganModule;
	}
	const pkg = resolveOrganPackage(organDef.name);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const rawMod = await import(pkg);
	const mod = rawMod as unknown as Record<string, unknown>;
	if (typeof mod.createOrgan !== "function") {
		throw new Error(
			`Organ package '${pkg}' does not export createOrgan(opts). ` +
				`Add \`export { createYourOrgan as createOrgan } from "./organ.js"\` to its index.`,
		);
	}
	return mod as unknown as OrganModule;
}

/**
 * Load a single organ from an absolute TypeScript file path.
 * Used by hot-reload (:reload) to swap an organ in-place without restart.
 */
export async function loadOrganFromPath(
	path: string,
	opts: Pick<MaterializerOptions, "cwd" | "loggerFor" | "writableRoots">,
): Promise<Organ> {
	const jitiMod = await getJiti().import(path);
	const mod = jitiMod as Record<string, unknown>;
	if (typeof mod.createOrgan !== "function") {
		throw new Error(`Organ at '${path}' does not export createOrgan(opts).`);
	}
	const typed = mod as unknown as OrganModule;
	return await typed.createOrgan({ cwd: opts.cwd, logger: opts.loggerFor?.(path), writableRoots: opts.writableRoots });
}

export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const organs: Organ[] = [];

	for (const organDef of definition.organs) {
		if (["ai", "discourse", "symbols"].includes(organDef.name)) continue;

		const label = organDef.path ? organDef.path : resolveOrganPackage(organDef.name);
		try {
			const mod = await loadOrganModule(organDef, opts.resolveExternalPath);
			const organ = await mod.createOrgan({
				cwd: opts.cwd,
				actions: organDef.actions.length > 0 ? organDef.actions : undefined,
				logger: opts.loggerFor?.(organDef.name),
				writableRoots: opts.writableRoots,
			});
			const gated =
				opts.allowedTools && opts.allowedTools.length > 0 ? wrapWithPermissions(organ, opts.allowedTools) : organ;
			organs.push(gated);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("does not export createOrgan")) {
				console.warn(`[blueprint] ${msg} Skipping.`);
			} else {
				throw new Error(`[blueprint] Failed to load organ '${label}': ${msg}`);
			}
		}
	}

	let modelId: string | undefined;
	if (definition.model) {
		modelId = `${definition.model.provider}/${definition.model.id}`;
	}

	return { organs, modelId };
}
