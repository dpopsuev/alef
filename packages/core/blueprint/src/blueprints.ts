import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parse } from "yaml";
import { compileAgentAdapterDefinitions } from "./organs.js";
import type {
	AgentDefinitionDependenciesConfig,
	AgentDefinitionInput,
	AgentDefinitionPackageSourceInput,
	AgentDefinitionSupervisorPolicyConfig,
	AgentModelSelector,
	AgentResourceMetadata,
	CompiledAgentDefinition,
	ResolvedAgentDefinitionChild,
} from "./types.js";

export const AGENT_RESOURCE_API_VERSION = "alef.dpopsuev.io/v1alpha1";
export const AGENT_RESOURCE_KIND = "AgentRuntime";

/**
 * Schema migration chain.
 *
 * Maps old apiVersion strings to a function that transforms the parsed
 * envelope to the current schema. Applied in sequence when loading a
 * blueprint that uses an older apiVersion.
 *
 * Add an entry here whenever the schema evolves — never change the
 * current version check below without adding a migration first.
 *
 * Example for a future v1beta1 → v1alpha1 downgrade:
 *   "alef.dpopsuev.io/v1beta1": (env) => ({ ...env, apiVersion: AGENT_RESOURCE_API_VERSION })
 */
const MIGRATION_CHAIN: Record<string, (envelope: Record<string, unknown>) => Record<string, unknown>> = {
	// No migrations yet. v1alpha1 is the only version that has ever existed.
};

const AgentModelSchema = Type.Object({
	provider: Type.String({ minLength: 1 }),
	id: Type.String({ minLength: 1 }),
	thinkingLevel: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
});

const AgentDefinitionChildSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	blueprint: Type.String({ minLength: 1 }),
});

const AgentDefinitionAdapterSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	path: Type.Optional(Type.String({ minLength: 1 })),
	actions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	cache: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			ttlMs: Type.Optional(Type.Integer({ minimum: 1 })),
			maxEntries: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
	runtime: Type.Optional(
		Type.Object({
			lsp: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean()),
					command: Type.Optional(Type.String({ minLength: 1 })),
				}),
			),
			treeSitter: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean()),
				}),
			),
			indexing: Type.Optional(
				Type.Object({
					preload: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("workspace")])),
				}),
			),
		}),
	),
});

const AgentDefinitionPackageSourceSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object({
		source: Type.String({ minLength: 1 }),
		extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		prompts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		themes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	}),
]);

const AgentDefinitionSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	model: Type.Optional(Type.Union([Type.String({ minLength: 1 }), AgentModelSchema])),
	systemPrompt: Type.Optional(Type.String()),
	adapters: Type.Optional(Type.Array(AgentDefinitionAdapterSchema)),
	organs: Type.Optional(Type.Array(AgentDefinitionAdapterSchema)),
	surfaces: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.Literal("sse"),
				events: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			}),
		),
	),
	capabilities: Type.Optional(
		Type.Object({
			tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			orchestration: Type.Optional(Type.Boolean()),
		}),
	),
	memory: Type.Optional(
		Type.Object({
			session: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("persistent")])),
			working: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
	),
	policies: Type.Optional(
		Type.Object({
			appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
		}),
	),
	loop: Type.Optional(
		Type.Object({
			strategy: Type.Optional(
				Type.Union([Type.Literal("default"), Type.Literal("minimal"), Type.Literal("ablation")]),
			),
			steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
			followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
			toolExecution: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")])),
			maxTurnsPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
			stopOnBudgetAction: Type.Optional(
				Type.Union([Type.Literal("inform"), Type.Literal("warn"), Type.Literal("throttle"), Type.Literal("abort")]),
			),
			ablation: Type.Optional(
				Type.Object({
					disableSteering: Type.Optional(Type.Boolean()),
					disableFollowUp: Type.Optional(Type.Boolean()),
					forceSequentialTools: Type.Optional(Type.Boolean()),
				}),
			),
		}),
	),
	delegation: Type.Optional(
		Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("manual"), Type.Literal("auto")])),
		}),
	),
	supervisor: Type.Optional(
		Type.Object({
			heartbeatIntervalMs: Type.Optional(Type.Integer({ minimum: 1000 })),
			heartbeatTimeoutMs: Type.Optional(Type.Integer({ minimum: 100 })),
			maxMissedHeartbeats: Type.Optional(Type.Integer({ minimum: 1 })),
			smokeTestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
			handoffTimeoutMs: Type.Optional(Type.Integer({ minimum: 100 })),
			maxFixIterations: Type.Optional(Type.Integer({ minimum: 1 })),
			upgradePolicy: Type.Optional(
				Type.Union([Type.Literal("rebuild_only"), Type.Literal("packages"), Type.Literal("self")]),
			),
		}),
	),
	hooks: Type.Optional(
		Type.Object({
			extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
	),
	dependencies: Type.Optional(
		Type.Object({
			packages: Type.Optional(Type.Array(AgentDefinitionPackageSourceSchema)),
			extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			prompts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			themes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
	),
	children: Type.Optional(Type.Array(AgentDefinitionChildSchema)),
});

type AgentDefinitionSchemaType = Static<typeof AgentDefinitionSchema>;

const agentDefinitionValidator = Compile(AgentDefinitionSchema);

/**
 *
 */
function normalizeStringArray(values: string[] | undefined): string[] {
	if (!values) {
		return [];
	}

	const unique = new Set<string>();
	for (const value of values) {
		const normalized = value.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}

	return Array.from(unique);
}

type AgentResourceEnvelope = {
	apiVersion: string;
	kind: string;
	metadata?: Record<string, unknown>;
	spec: Record<string, unknown>;
};

/**
 *
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 *
 */
function isAgentResourceEnvelope(value: unknown): value is AgentResourceEnvelope {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.apiVersion === "string" &&
		typeof value.kind === "string" &&
		isRecord(value.spec) &&
		(value.metadata === undefined || isRecord(value.metadata))
	);
}

/**
 *
 */
function normalizeStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const normalized: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const normalizedKey = key.trim();
		const normalizedValue = typeof raw === "string" ? raw.trim() : "";
		if (normalizedKey.length === 0 || normalizedValue.length === 0) {
			continue;
		}
		normalized[normalizedKey] = normalizedValue;
	}
	return normalized;
}

/**
 *
 */
function setIfNonEmpty(target: AgentDefinitionPackageSourceInput, key: "extensions" | "skills" | "prompts" | "themes", values: string[]): void {
	if (values.length > 0) {
		target[key] = values;
	}
}

/**
 *
 */
function normalizePackageSources(
	packages: NonNullable<AgentDefinitionSchemaType["dependencies"]>["packages"],
): AgentDefinitionDependenciesConfig["packages"] {
	if (!packages) {
		return [];
	}
	const normalized: AgentDefinitionDependenciesConfig["packages"] = [];
	const seen = new Set<string>();
	for (const entry of packages) {
		const source = (typeof entry === "string" ? entry : entry.source).trim();
		if (source.length === 0 || seen.has(source)) {
			continue;
		}
		seen.add(source);

		if (typeof entry === "string") {
			normalized.push(source);
			continue;
		}

		const normalizedEntry: AgentDefinitionPackageSourceInput = { source };
		setIfNonEmpty(normalizedEntry, "extensions", normalizeStringArray(entry.extensions));
		setIfNonEmpty(normalizedEntry, "skills", normalizeStringArray(entry.skills));
		setIfNonEmpty(normalizedEntry, "prompts", normalizeStringArray(entry.prompts));
		setIfNonEmpty(normalizedEntry, "themes", normalizeStringArray(entry.themes));
		normalized.push(normalizedEntry);
	}
	return normalized;
}

/**
 *
 */
function normalizeDependencies(
	dependencies: AgentDefinitionSchemaType["dependencies"],
): CompiledAgentDefinition["dependencies"] | undefined {
	if (!dependencies) {
		return undefined;
	}
	const normalized: AgentDefinitionDependenciesConfig = {
		packages: normalizePackageSources(dependencies.packages),
		extensions: normalizeStringArray(dependencies.extensions),
		skills: normalizeStringArray(dependencies.skills),
		prompts: normalizeStringArray(dependencies.prompts),
		themes: normalizeStringArray(dependencies.themes),
	};
	if (
		normalized.packages.length === 0 &&
		normalized.extensions.length === 0 &&
		normalized.skills.length === 0 &&
		normalized.prompts.length === 0 &&
		normalized.themes.length === 0
	) {
		return undefined;
	}
	return normalized;
}

/**
 *
 */
function normalizeResourceMetadata(metadata: Record<string, unknown> | undefined): AgentResourceMetadata {
	const name =
		typeof metadata?.name === "string" && metadata.name.trim().length > 0 ? metadata.name.trim() : undefined;
	return {
		name,
		labels: normalizeStringMap(metadata?.labels),
		annotations: normalizeStringMap(metadata?.annotations),
	};
}

/**
 *
 */
function normalizeModelSelector(model: string | AgentModelSelector | undefined): AgentModelSelector | undefined {
	if (!model) {
		return undefined;
	}

	if (typeof model !== "string") {
		return model;
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex === model.length - 1) {
		throw new Error(`Invalid model selector "${model}". Expected "provider/model-id".`);
	}

	return {
		provider: model.slice(0, slashIndex),
		id: model.slice(slashIndex + 1),
	};
}

/**
 *
 */
function resolveChildBlueprints(
	children: AgentDefinitionSchemaType["children"],
	baseDir: string | undefined,
): ResolvedAgentDefinitionChild[] {
	return (children ?? []).map((child) => ({
		name: child.name,
		blueprint:
			baseDir && !child.blueprint.startsWith("/") ? resolve(baseDir, child.blueprint) : resolve(child.blueprint),
	}));
}

/**
 *
 */
function normalizeAblationConfig(
	ablation: NonNullable<AgentDefinitionSchemaType["loop"]>["ablation"],
): NonNullable<CompiledAgentDefinition["loop"]>["ablation"] {
	if (!ablation) return undefined;
	return {
		disableSteering: ablation.disableSteering ?? false,
		disableFollowUp: ablation.disableFollowUp ?? false,
		forceSequentialTools: ablation.forceSequentialTools ?? false,
	};
}

/**
 *
 */
function normalizeLoopConfig(loop: AgentDefinitionSchemaType["loop"]): CompiledAgentDefinition["loop"] | undefined {
	if (!loop) {
		return undefined;
	}

	return {
		strategy: loop.strategy,
		steeringMode: loop.steeringMode,
		followUpMode: loop.followUpMode,
		toolExecution: loop.toolExecution,
		maxTurnsPerRun: loop.maxTurnsPerRun,
		stopOnBudgetAction: loop.stopOnBudgetAction,
		ablation: normalizeAblationConfig(loop.ablation),
	};
}

/**
 *
 */
function normalizeDelegationConfig(
	delegation: AgentDefinitionSchemaType["delegation"],
): CompiledAgentDefinition["delegation"] | undefined {
	if (!delegation) {
		return undefined;
	}

	return {
		mode: delegation.mode ?? "manual",
	};
}

const DEFAULT_SUPERVISOR_POLICY: AgentDefinitionSupervisorPolicyConfig = {
	heartbeatIntervalMs: 30_000,
	heartbeatTimeoutMs: 10_000,
	maxMissedHeartbeats: 3,
	smokeTestTimeoutMs: 30_000,
	handoffTimeoutMs: 10_000,
	maxFixIterations: 3,
	upgradePolicy: "rebuild_only",
};

/**
 *
 */
function normalizeSupervisorPolicy(
	supervisor: AgentDefinitionSchemaType["supervisor"],
): CompiledAgentDefinition["supervisor"] | undefined {
	if (!supervisor) {
		return undefined;
	}
	return {
		heartbeatIntervalMs: Math.max(
			1000,
			supervisor.heartbeatIntervalMs ?? DEFAULT_SUPERVISOR_POLICY.heartbeatIntervalMs,
		),
		heartbeatTimeoutMs: Math.max(100, supervisor.heartbeatTimeoutMs ?? DEFAULT_SUPERVISOR_POLICY.heartbeatTimeoutMs),
		maxMissedHeartbeats: Math.max(1, supervisor.maxMissedHeartbeats ?? DEFAULT_SUPERVISOR_POLICY.maxMissedHeartbeats),
		smokeTestTimeoutMs: Math.max(1000, supervisor.smokeTestTimeoutMs ?? DEFAULT_SUPERVISOR_POLICY.smokeTestTimeoutMs),
		handoffTimeoutMs: Math.max(100, supervisor.handoffTimeoutMs ?? DEFAULT_SUPERVISOR_POLICY.handoffTimeoutMs),
		maxFixIterations: Math.max(1, supervisor.maxFixIterations ?? DEFAULT_SUPERVISOR_POLICY.maxFixIterations),
		upgradePolicy: supervisor.upgradePolicy ?? DEFAULT_SUPERVISOR_POLICY.upgradePolicy,
	};
}

/**
 *
 */
function validateOrchestrationConsistency(
	hasAdapter: boolean,
	orchestrationFlag: boolean | undefined,
	sourcePath: string | undefined,
): void {
	if (hasAdapter === (orchestrationFlag === true)) return;

	const location = sourcePath ? ` in ${sourcePath}` : "";
	if (hasAdapter) {
		throw new Error(
			`Invalid agent definition${location}: orchestration adapter requires capabilities.orchestration: true`,
		);
	}
	throw new Error(
		`Invalid agent definition${location}: capabilities.orchestration: true requires an orchestration adapter`,
	);
}

/**
 *
 */
export function compileAgentDefinition(
	input: AgentDefinitionInput,
	options: { sourcePath?: string; resource?: CompiledAgentDefinition["resource"] } = {},
): CompiledAgentDefinition {
	if (!agentDefinitionValidator.Check(input)) {
		const [firstError] = agentDefinitionValidator.Errors(input);
		const errorMessage = firstError.message;
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: ${errorMessage}`);
	}

	const sourcePath = options.sourcePath ? resolve(options.sourcePath) : undefined;
	const baseDir = sourcePath ? dirname(sourcePath) : undefined;
	const adapterInput = input.adapters;
	const adapters = compileAgentAdapterDefinitions(adapterInput);
	const toolNames = normalizeStringArray(input.capabilities?.tools);
	const hasOrchestrationAdapter = adapters.some(
		(adapter) => adapter.name === "orchestration" || adapter.name === "agent",
	);
	validateOrchestrationConsistency(hasOrchestrationAdapter, input.capabilities?.orchestration, options.sourcePath);

	const compiled: CompiledAgentDefinition = {
		name: input.name.trim(),
		sourcePath,
		baseDir,
		model: normalizeModelSelector(input.model),
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must collapse to undefined
		systemPrompt: input.systemPrompt?.trim() || undefined,
		adapters: adapters,
		capabilities: {
			tools: toolNames,
			orchestration: input.capabilities?.orchestration ?? false,
		},
		memory: {
			session: input.memory?.session ?? "memory",
			working: structuredClone(input.memory?.working ?? {}),
		},
		policies: {
			appendSystemPrompt: normalizeStringArray(input.policies?.appendSystemPrompt),
		},
		loop: normalizeLoopConfig(input.loop),
		delegation: normalizeDelegationConfig(input.delegation),
		supervisor: normalizeSupervisorPolicy(input.supervisor),
		hooks: {
			extensions: normalizeStringArray(input.hooks?.extensions),
		},
		surfaces: input.surfaces ?? [],
		children: resolveChildBlueprints(input.children, baseDir),
	};
	const dependencies = normalizeDependencies(input.dependencies);
	if (dependencies) {
		compiled.dependencies = dependencies;
	}
	if (options.resource) {
		compiled.resource = options.resource;
	}
	return compiled;
}

/**
 *
 */
function migrateEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
	if (envelope.apiVersion === AGENT_RESOURCE_API_VERSION) return envelope;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- apiVersion is typed as string in envelope
	const migrate = MIGRATION_CHAIN[envelope.apiVersion as string];
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard for future MIGRATION_CHAIN entries
	if (!migrate) {
		throw new Error(
			`Unsupported agent resource apiVersion "${String(envelope.apiVersion)}". ` +
				`Expected "${AGENT_RESOURCE_API_VERSION}" or a migratable version.`,
		);
	}
	return migrate(envelope);
}

/**
 *
 */
function resolveSpecName(spec: Record<string, unknown>, metadata: AgentResourceMetadata): void {
	if (typeof spec.name === "string" && spec.name.trim().length > 0) return;
	if (metadata.name) {
		spec.name = metadata.name;
		return;
	}
	throw new Error("Invalid agent resource: spec.name is required (or metadata.name must be set).");
}

/**
 *
 */
function compileResourceEnvelope(
	parsed: AgentResourceEnvelope,
	options: { sourcePath?: string },
): CompiledAgentDefinition {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unnecessary-type-assertion -- narrowed by isAgentResourceEnvelope guard; assertion restores envelope shape after migration
	const current = migrateEnvelope(parsed as unknown as Record<string, unknown>) as typeof parsed;
	if (current.kind !== AGENT_RESOURCE_KIND) {
		throw new Error(`Unsupported agent resource kind "${current.kind}". Expected "${AGENT_RESOURCE_KIND}".`);
	}
	const resourceMetadata = normalizeResourceMetadata(current.metadata);
	const spec: Record<string, unknown> = { ...current.spec };
	resolveSpecName(spec, resourceMetadata);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spec validated by compileAgentDefinition
	return compileAgentDefinition(spec as unknown as AgentDefinitionInput, {
		sourcePath: options.sourcePath,
		resource: {
			apiVersion: current.apiVersion,
			kind: current.kind,
			metadata: resourceMetadata,
		},
	});
}

/**
 *
 */
export function parseAgentDefinitionYaml(
	yamlText: string,
	options: { sourcePath?: string } = {},
): CompiledAgentDefinition {
	const parsed = parse(yamlText) as unknown;
	if (!isRecord(parsed)) {
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: expected a YAML object`);
	}

	if (isAgentResourceEnvelope(parsed)) {
		return compileResourceEnvelope(parsed, options);
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- parsed validated by compileAgentDefinition
	return compileAgentDefinition(parsed as unknown as AgentDefinitionInput, options);
}

/**
 *
 */
export function loadAgentDefinition(path: string): CompiledAgentDefinition {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Agent definition not found: ${resolvedPath}`);
	}

	const yamlText = readFileSync(resolvedPath, "utf8");
	return parseAgentDefinitionYaml(yamlText, { sourcePath: resolvedPath });
}

/**
 *
 */
export function findAgentDefinitionPath(cwd: string): string | undefined {
	const candidates = [
		resolve(cwd, "agent.yaml"),
		resolve(cwd, "agent.yml"),
		resolve(cwd, ".alef/agent.yaml"),
		resolve(cwd, ".alef/agent.yml"),
	];

	return candidates.find((candidate) => existsSync(candidate));
}

/**
 *
 */
export function resolveAgentChildDefinition(
	definition: CompiledAgentDefinition | undefined,
	reference: string,
	cwd: string,
): CompiledAgentDefinition {
	const normalizedReference = reference.trim();
	if (normalizedReference.length === 0) {
		throw new Error("Child agent reference cannot be empty.");
	}

	const childBlueprint = definition?.children.find((child) => child.name === normalizedReference);
	if (childBlueprint) {
		return loadAgentDefinition(childBlueprint.blueprint);
	}

	const resolvedPath = normalizedReference.startsWith("/")
		? normalizedReference
		: definition?.baseDir
			? resolve(definition.baseDir, normalizedReference)
			: resolve(cwd, normalizedReference);

	return loadAgentDefinition(resolvedPath);
}

/**
 * mergeAgentDefinitions — deep-merge an overlay definition over a base.
 *
 * Follows the Docker Compose overlay convention:
 *   - Scalar fields: overlay wins if defined.
 *   - Array fields (adapters, surfaces, children): overlay replaces base if non-empty.
 *   - Deeply-nested objects: merged recursively, overlay wins on conflicts.
 *
 * Intended for profile overlays: loadAgentDefinition(base) + loadAgentDefinition(overlay).
 * The overlay file is typically a sparse file with only the fields that differ per profile.
 */
function mergeAdapterLists(
	base: CompiledAgentDefinition["adapters"],
	overlay: CompiledAgentDefinition["adapters"],
): CompiledAgentDefinition["adapters"] {
	if (overlay.length === 0) return base;
	const merged = new Map(base.map((o) => [o.name, o]));
	for (const o of overlay) {
		const existing = merged.get(o.name);
		if (existing) {
			merged.set(o.name, {
				...existing,
				...o,
				actions: o.actions.length > 0 ? o.actions : existing.actions,
				toolNames: o.toolNames.length > 0 ? o.toolNames : existing.toolNames,
				blockedPatterns: o.blockedPatterns ?? existing.blockedPatterns,
			});
		} else {
			merged.set(o.name, o);
		}
	}
	return [...merged.values()];
}

/**
 *
 */
export function mergeAgentDefinitions(
	base: CompiledAgentDefinition,
	overlay: CompiledAgentDefinition,
): CompiledAgentDefinition {
	return {
		// Scalars: overlay wins when defined.
		name: overlay.name,
		sourcePath: base.sourcePath,
		baseDir: base.baseDir,
		model: overlay.model ?? base.model,
		systemPrompt: overlay.systemPrompt ?? base.systemPrompt,

		// Adapters: merge by name. Overlay adapter config wins per-adapter field.
		// Base adapters not in overlay are kept. Overlay adapters not in base are added.
		adapters: mergeAdapterLists(base.adapters, overlay.adapters),
		surfaces: overlay.surfaces.length > 0 ? overlay.surfaces : base.surfaces,
		children: overlay.children.length > 0 ? overlay.children : base.children,

		// Structured: merge at field level, overlay wins per key.
		capabilities: {
			tools: overlay.capabilities.tools.length > 0 ? overlay.capabilities.tools : base.capabilities.tools,
			orchestration: overlay.capabilities.orchestration || base.capabilities.orchestration,
		},
		memory: {
			session: overlay.memory.session !== "memory" ? overlay.memory.session : base.memory.session,
			working: { ...base.memory.working, ...overlay.memory.working },
		},
		policies: {
			appendSystemPrompt:
				overlay.policies.appendSystemPrompt.length > 0
					? overlay.policies.appendSystemPrompt
					: base.policies.appendSystemPrompt,
		},
		loop: overlay.loop ?? base.loop,
		delegation: overlay.delegation ?? base.delegation,
		supervisor: overlay.supervisor ?? base.supervisor,
		hooks: {
			extensions: overlay.hooks.extensions.length > 0 ? overlay.hooks.extensions : base.hooks.extensions,
		},
		dependencies: overlay.dependencies ?? base.dependencies,
		resource: overlay.resource ?? base.resource,
	};
}
