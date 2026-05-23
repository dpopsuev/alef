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

import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";

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
	supervisor: "@dpopsuev/alef-organ-supervisor",
	eval: "@dpopsuev/alef-organ-eval",
	todos: "@dpopsuev/alef-organ-todos",
	skills: "@dpopsuev/alef-organ-skills",
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
			// Intercept every motor event on the wildcard channel before the
			// organ's own subscriptions fire.
			const offGate = nerve.motor.subscribe("*", (event) => {
				if (allowed.has(event.type)) return; // permitted — organ handles it

				// Denied: publish a sense error with the matching toolCallId.
				const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
				const sensePayload: SensePublishInput = {
					type: event.type,
					payload: toolCallId !== undefined ? { toolCallId } : {},
					isError: true,
					errorMessage:
						`Permission denied: '${event.type}' is not in allowed_tools. ` +
						`Add it to permissions.allowed_tools in config.yaml to enable it.`,
					correlationId: event.correlationId,
				};
				nerve.sense.publish(sensePayload);
			});

			// Mount the underlying organ normally — its own motor subscribers fire
			// in addition to the gate, but the gate's sense error is published first
			// so waitForToolResult resolves with the error before the organ's result.
			const offOrgan = organ.mount(nerve);
			return () => {
				offGate();
				offOrgan();
			};
		},
	};
}

export const DEFAULT_COMPILED_DEFINITION: CompiledAgentDefinition = {
	name: "default",
	organs: [
		{ name: "fs", actions: [], toolNames: [] },
		{ name: "shell", actions: [], toolNames: [] },
		{ name: "nodesh", actions: [], toolNames: [] },
	],
	model: undefined,
	children: [],
	surfaces: [],
	capabilities: { tools: [], supervisor: false },
	memory: { session: "memory", working: {} },
	policies: { appendSystemPrompt: [] },
	hooks: { extensions: [] },
};

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

	// Resolve alias → package. Unknown names are treated as npm specifiers directly.
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

export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const organs: Organ[] = [];

	for (const organDef of definition.organs) {
		// Skip legacy/unimplemented organs silently.
		// ai and discourse are mounted by main.ts; symbols/supervisor are roadmap.
		if (["ai", "discourse", "symbols", "supervisor"].includes(organDef.name)) continue;

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
