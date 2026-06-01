/**
 * Blueprint materializer — loads Organ instances from a CompiledAgentDefinition.
 *
 * No per-organ knowledge. No if-chains. No pre-registration.
 * Each organ is loaded dynamically and must export createOrgan(opts).
 *
 * Resolution order per organ entry:
 *   path  → jiti.import(resolvedPath)       — TypeScript file, no build step
 *   name  → import(BUILTIN_PACKAGES[name])  — built-in alias
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
import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { parse as parseYaml } from "yaml";

/**
 * Short alias → npm package for organs shipped with Alef.
 * Lives here — not in blueprint — because the materializer is the
 * composition root that knows what it ships. Blueprint has zero organ knowledge.
 * Add a new organ here only; blueprint needs no change.
 */
const BUILTIN_PACKAGES: Record<string, string> = {
	fs: "@dpopsuev/alef-organ-fs",
	shell: "@dpopsuev/alef-organ-shell",
	nodesh: "@dpopsuev/alef-organ-nodesh",
	lector: "@dpopsuev/alef-organ-lector",
	orchestration: "@dpopsuev/alef-organ-orchestration",
	delegate: "@dpopsuev/alef-organ-delegate",
	eval: "@dpopsuev/alef-organ-eval",
	todos: "@dpopsuev/alef-organ-todos",
	skills: "@dpopsuev/alef-organ-skills",
	web: "@dpopsuev/alef-organ-web",
};

import type { Nerve, Organ, OrganLogger, SensePublishInput } from "@dpopsuev/alef-spine";
import { createJiti } from "jiti";

/** Common options passed to every organ factory. */
export interface OrganFactoryOptions {
	cwd: string;
	actions?: string[];
	logger?: OrganLogger;
}

/** Expected shape of an organ module — must export createOrgan. */
interface OrganModule {
	createOrgan: (opts: OrganFactoryOptions) => Organ;
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
}

export interface MaterializerResult {
	organs: Organ[];
	modelId: string | undefined;
}

/**
 * Default organ set used when no --blueprint is supplied.
 * Keeps main.ts free of organ imports — the materializer is the only
 * instantiation path for both blueprint and bare invocations.
 */
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
			// Wrap the nerve so the organ's own motor subscribers receive a gated
			// version of every handler. This fires at subscription time, so the
			// check runs before the organ's logic and does not race with wildcards.
			const gatedNerve: Nerve = {
				...nerve,
				motor: {
					...nerve.motor,
					subscribe: (type, handler) => {
						// Wildcard subscriptions (observability organs) bypass gating.
						if (type === "*") return nerve.motor.subscribe(type, handler);
						return nerve.motor.subscribe(type, (event) => {
							if (allowed.has(event.type)) {
								void handler(event);
								return;
							}
							// Denied: publish sense error with matching toolCallId.
							const toolCallId =
								typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
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

/** Path to the user organs config file. Read at call time so ALEF_PM_ROOT overrides work in tests. */
export function userOrgansConfigPath(): string {
	const root = process.env.ALEF_PM_ROOT ?? join(homedir(), ".config", "alef");
	return join(root, "organs.yaml");
}

type OrganEntry = string | { name: string; path?: string; actions?: string[] };

/**
 * Load user organs config from ~/.config/alef/organs.yaml.
 * Returns null when the file does not exist (caller falls back to default).
 *
 * Format:
 *   organs:
 *     - fs
 *     - shell
 *     - name: my-organ
 *       path: /absolute/path/to/organ.ts
 *       actions: [read]
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

async function loadOrganModule(organDef: CompiledAgentDefinition["organs"][number]): Promise<OrganModule> {
	if (organDef.path) {
		// TypeScript file — load via jiti without a build step.
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

	// Resolve alias → package. Check alef-pm managed node_modules first,
	// then fall back to built-in monorepo packages and bare npm specifiers.
	const { resolveOrganPath } = await import("./alef-pm.js");
	const pmPath = resolveOrganPath(organDef.name);
	if (pmPath) {
		const jitiMod = await getJiti().import(pmPath);
		const mod = jitiMod as Record<string, unknown>;
		if (typeof mod.createOrgan !== "function") {
			throw new Error(`Organ at '${pmPath}' (alef-pm managed) does not export createOrgan(opts).`);
		}
		return mod as unknown as OrganModule;
	}
	const pkg = BUILTIN_PACKAGES[organDef.name] ?? organDef.name;
	// Dynamic import — works for both built-in monorepo packages and npm packages.
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
	opts: Pick<MaterializerOptions, "cwd" | "loggerFor">,
): Promise<Organ> {
	const jitiMod = await getJiti().import(path);
	const mod = jitiMod as Record<string, unknown>;
	if (typeof mod.createOrgan !== "function") {
		throw new Error(`Organ at '${path}' does not export createOrgan(opts).`);
	}
	const typed = mod as unknown as OrganModule;
	return typed.createOrgan({ cwd: opts.cwd, logger: opts.loggerFor?.(path) });
}

export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const organs: Organ[] = [];

	for (const organDef of definition.organs) {
		// Skip legacy/unimplemented organs silently.
		// ai and discourse are mounted by main.ts; symbols is roadmap.
		if (["ai", "discourse", "symbols"].includes(organDef.name)) continue;

		const label = organDef.path ? organDef.path : (BUILTIN_PACKAGES[organDef.name] ?? organDef.name);
		try {
			const mod = await loadOrganModule(organDef);
			const organ = mod.createOrgan({
				cwd: opts.cwd,
				actions: organDef.actions.length > 0 ? organDef.actions : undefined,
				logger: opts.loggerFor?.(organDef.name),
			});
			const gated =
				opts.allowedTools && opts.allowedTools.length > 0 ? wrapWithPermissions(organ, opts.allowedTools) : organ;
			organs.push(gated);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Warn but don't crash for unsupported/roadmap organs.
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
