import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parse } from "yaml";
import { compileAgentOrganDefinitions, listToolNamesForOrgans } from "./organs.js";
import type {
	AgentDefinitionInput,
	AgentModelSelector,
	CompiledAgentDefinition,
	ResolvedAgentDefinitionChild,
} from "./types.js";

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
	name: Type.Union([Type.Literal("fs"), Type.Literal("shell"), Type.Literal("supervisor")]),
	actions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

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
	hooks: Type.Optional(
		Type.Object({
			extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
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

export function compileAgentDefinition(
	input: AgentDefinitionInput,
	options: { sourcePath?: string } = {},
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

	return {
		name: input.name.trim(),
		sourcePath,
		baseDir,
		model: normalizeModelSelector(input.model),
		systemPrompt: input.systemPrompt?.trim() || undefined,
		organs,
		capabilities: {
			tools: toolNames,
			supervisor: input.capabilities?.supervisor ?? hasSupervisorOrgan,
		},
		memory: {
			session: input.memory?.session ?? "memory",
			working: structuredClone(input.memory?.working ?? {}),
		},
		policies: {
			appendSystemPrompt: normalizeStringArray(input.policies?.appendSystemPrompt),
		},
		hooks: {
			extensions: normalizeStringArray(input.hooks?.extensions),
		},
		children: resolveChildBlueprints(input.children, baseDir),
	};
}

export function parseAgentDefinitionYaml(
	yamlText: string,
	options: { sourcePath?: string } = {},
): CompiledAgentDefinition {
	const parsed = parse(yamlText) as unknown;
	if (!parsed || typeof parsed !== "object") {
		const location = options.sourcePath ? ` in ${options.sourcePath}` : "";
		throw new Error(`Invalid agent definition${location}: expected a YAML object`);
	}

	return compileAgentDefinition(parsed as AgentDefinitionInput, options);
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
