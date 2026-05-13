import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parse } from "yaml";
import { compileAgentOrganDefinitions, listToolNamesForOrgans } from "./organs.js";
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

const AgentDefinitionOrganSchema = Type.Object({
	name: Type.Union([
		Type.Literal("fs"),
		Type.Literal("shell"),
		Type.Literal("symbols"),
		Type.Literal("lector"),
		Type.Literal("supervisor"),
	]),
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
	organs: Type.Optional(Type.Array(AgentDefinitionOrganSchema)),
	capabilities: Type.Optional(
		Type.Object({
			tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			supervisor: Type.Optional(Type.Boolean()),
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

function normalizePackageSources(
	packages: NonNullable<AgentDefinitionSchemaType["dependencies"]>["packages"],
): AgentDefinitionDependenciesConfig["packages"] {
	if (!packages) {
		return [];
	}
	const normalized: AgentDefinitionDependenciesConfig["packages"] = [];
	const seen = new Set<string>();
	for (const entry of packages) {
		if (typeof entry === "string") {
			const source = entry.trim();
			if (source.length === 0 || seen.has(source)) {
				continue;
			}
			seen.add(source);
			normalized.push(source);
			continue;
		}

		const source = entry.source.trim();
		if (source.length === 0 || seen.has(source)) {
			continue;
		}
		seen.add(source);
		const normalizedEntry: AgentDefinitionPackageSourceInput = { source };
		const extensions = normalizeStringArray(entry.extensions);
		const skills = normalizeStringArray(entry.skills);
		const prompts = normalizeStringArray(entry.prompts);
		const themes = normalizeStringArray(entry.themes);
		if (extensions.length > 0) {
			normalizedEntry.extensions = extensions;
		}
		if (skills.length > 0) {
			normalizedEntry.skills = skills;
		}
		if (prompts.length > 0) {
			normalizedEntry.prompts = prompts;
		}
		if (themes.length > 0) {
			normalizedEntry.themes = themes;
		}
		normalized.push(normalizedEntry);
	}
	return normalized;
}

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

function normalizeResourceMetadata(metadata: Record<string, unknown> | undefined): AgentResourceMetadata {
	const name =
		typeof metadata?.name === "string" && metadata.name.trim().length > 0 ? metadata.name.trim() : undefined;
	return {
		name,
		labels: normalizeStringMap(metadata?.labels),
		annotations: normalizeStringMap(metadata?.annotations),
	};
}

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
		ablation: loop.ablation
			? {
					disableSteering: loop.ablation.disableSteering ?? false,
					disableFollowUp: loop.ablation.disableFollowUp ?? false,
					forceSequentialTools: loop.ablation.forceSequentialTools ?? false,
				}
			: undefined,
	};
}

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

export function compileAgentDefinition(
	input: AgentDefinitionInput,
	options: { sourcePath?: string; resource?: CompiledAgentDefinition["resource"] } = {},
): CompiledAgentDefinition {
	if (!agentDefinitionValidator.Check(input)) {
		const [firstError] = agentDefinitionValidator.Errors(input);
		const errorMessage = firstError?.message ?? "Unknown validation error";
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: ${errorMessage}`);
	}

	const sourcePath = options.sourcePath ? resolve(options.sourcePath) : undefined;
	const baseDir = sourcePath ? dirname(sourcePath) : undefined;
	const organs = compileAgentOrganDefinitions(input.organs);
	const legacyToolNames = normalizeStringArray(input.capabilities?.tools);
	const toolNames =
		organs.length > 0 ? [...new Set([...listToolNamesForOrgans(organs), ...legacyToolNames])] : legacyToolNames;
	const hasSupervisorOrgan = organs.some((organ) => organ.name === "supervisor");
	if (hasSupervisorOrgan && input.capabilities?.supervisor !== true) {
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: supervisor organ requires capabilities.supervisor: true`);
	}
	if (!hasSupervisorOrgan && input.capabilities?.supervisor === true) {
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: capabilities.supervisor: true requires a supervisor organ`);
	}

	const compiled: CompiledAgentDefinition = {
		name: input.name.trim(),
		sourcePath,
		baseDir,
		model: normalizeModelSelector(input.model),
		systemPrompt: input.systemPrompt?.trim() || undefined,
		organs,
		capabilities: {
			tools: toolNames,
			supervisor: input.capabilities?.supervisor ?? false,
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
		if (parsed.apiVersion !== AGENT_RESOURCE_API_VERSION) {
			throw new Error(
				`Unsupported agent resource apiVersion "${parsed.apiVersion}". Expected "${AGENT_RESOURCE_API_VERSION}".`,
			);
		}
		if (parsed.kind !== AGENT_RESOURCE_KIND) {
			throw new Error(`Unsupported agent resource kind "${parsed.kind}". Expected "${AGENT_RESOURCE_KIND}".`);
		}
		const resourceMetadata = normalizeResourceMetadata(parsed.metadata);
		const spec: Record<string, unknown> = { ...parsed.spec };
		if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
			if (resourceMetadata.name) {
				spec.name = resourceMetadata.name;
			}
		}
		if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
			throw new Error("Invalid agent resource: spec.name is required (or metadata.name must be set).");
		}
		return compileAgentDefinition(spec as unknown as AgentDefinitionInput, {
			sourcePath: options.sourcePath,
			resource: {
				apiVersion: parsed.apiVersion,
				kind: parsed.kind,
				metadata: resourceMetadata,
			},
		});
	}

	return compileAgentDefinition(parsed as unknown as AgentDefinitionInput, options);
}

export function loadAgentDefinition(path: string): CompiledAgentDefinition {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Agent definition not found: ${resolvedPath}`);
	}

	const yamlText = readFileSync(resolvedPath, "utf8");
	return parseAgentDefinitionYaml(yamlText, { sourcePath: resolvedPath });
}

export function findAgentDefinitionPath(cwd: string): string | undefined {
	const candidates = [
		resolve(cwd, "agent.yaml"),
		resolve(cwd, "agent.yml"),
		resolve(cwd, ".alef/agent.yaml"),
		resolve(cwd, ".alef/agent.yml"),
	];

	return candidates.find((candidate) => existsSync(candidate));
}

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
