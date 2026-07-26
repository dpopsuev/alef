/**
 * Compiled blueprint artifact — the one immutable, reproducible record of what a
 * running agent actually is: which adapter packages at which exact versions, what
 * they're each allowed to do, what commands they own, and under what budget/permission
 * constraints. Materializer-agnostic and dependency-free: callers resolve packages and
 * command ownership (which requires loading adapter modules) and pass the results in.
 */

import { createHash } from "node:crypto";
import type {
	AgentDefinitionBudgetConfig,
	AgentDefinitionSurfaceInput,
	AgentModelSelector,
	CompiledAgentDefinition,
} from "./types.js";

/** Exact identity of one resolved adapter package: what it is, not just what it's called. */
export interface ResolvedPackageIdentity {
	/** Adapter name/alias as declared in the blueprint (e.g. "fs"). */
	readonly adapter: string;
	/** Resolved package specifier (e.g. "@dpopsuev/alef-tool-fs"), or "_external" for a path-loaded adapter. */
	readonly package: string;
	/** Exact installed version from the resolved package.json, or "local" when there is none to read. */
	readonly version: string;
	/** npm scope without the leading "@" (e.g. "dpopsuev"), or "local" for path-loaded/unscoped adapters. */
	readonly vendor: string;
}

/** OCAP grant recorded into the artifact — undefined roots means unrestricted access. */
export interface BlueprintPermissions {
	readonly writableRoots: readonly string[] | undefined;
}

/** Declared network surface: what the blueprint asks for, not what actually got bound at runtime. */
export interface BlueprintPortDeclaration {
	readonly type: string;
	readonly port: number | undefined;
}

/** One compiled, hashed, frozen record of an agent's exact runtime configuration. */
export interface CompiledBlueprintArtifact {
	readonly name: string;
	readonly sourcePath: string | undefined;
	readonly model: AgentModelSelector | undefined;
	readonly systemPrompt: string | undefined;
	readonly packages: readonly ResolvedPackageIdentity[];
	/** Fully-qualified command/tool name -> owning adapter name. */
	readonly commandOwnership: Readonly<Record<string, string>>;
	readonly permissions: BlueprintPermissions;
	readonly budgets: AgentDefinitionBudgetConfig;
	readonly ports: readonly BlueprintPortDeclaration[];
	/** sha256 over the reproducible fields above (excludes sourcePath and compiledAt). */
	readonly artifactHash: string;
	readonly compiledAt: string;
}

/** Inputs a caller (the materializer) must resolve before an artifact can be compiled. */
export interface CompileArtifactContext {
	readonly packages: readonly ResolvedPackageIdentity[];
	readonly commandOwnership: Readonly<Record<string, string>>;
	readonly writableRoots: readonly string[] | undefined;
}

/** Narrows an unknown value to a plain (non-array, non-null) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively sorts object keys so JSON.stringify produces the same text regardless of insertion order. */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = canonicalize(value[key]);
		}
		return sorted;
	}
	return value;
}

/** Deterministic sha256 over a value's canonical (key-sorted) JSON form. */
export function computeArtifactHash(value: unknown): string {
	const canonical = JSON.stringify(canonicalize(value));
	return createHash("sha256").update(canonical).digest("hex");
}

/** Freezes an object graph recursively so nothing downstream can mutate a compiled artifact. */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

/** Project a blueprint's declared surfaces into the artifact's port-declaration shape. */
function surfacePorts(surfaces: readonly AgentDefinitionSurfaceInput[]): BlueprintPortDeclaration[] {
	return surfaces.map((surface) => ({ type: surface.type, port: surface.port }));
}

/**
 * Compile a CompiledAgentDefinition plus its resolved runtime context into one immutable,
 * content-hashed artifact. The hash covers only reproducible fields -- the same blueprint
 * resolved against the same installed packages always hashes the same, regardless of
 * machine, absolute path, or wall-clock time.
 */
export function compileBlueprintArtifact(
	definition: CompiledAgentDefinition,
	context: CompileArtifactContext,
): CompiledBlueprintArtifact {
	const reproducible = {
		name: definition.name,
		model: definition.model,
		systemPrompt: definition.systemPrompt,
		packages: context.packages,
		commandOwnership: context.commandOwnership,
		permissions: { writableRoots: context.writableRoots },
		budgets: definition.budget ?? {},
		ports: surfacePorts(definition.surfaces),
	};

	const artifact: CompiledBlueprintArtifact = {
		...reproducible,
		sourcePath: definition.sourcePath,
		artifactHash: computeArtifactHash(reproducible),
		compiledAt: new Date().toISOString(),
	};

	return deepFreeze(artifact);
}
