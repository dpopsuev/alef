import {
	compileAgentToolsLock,
	type AgentToolsLock,
	type JsonValue,
	type ResolvedAgentToolDescriptor,
	type ResolvedAgentToolPackage,
} from "@danypops/packed/agent-tools";
import type { JsonValue as VehicleJsonValue, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";

/** Inputs needed to lock one static Vehicle manifest. */
export interface VehicleAgentToolsLockInput {
	readonly source: string;
	readonly integrity: string;
	readonly manifestPath: string;
	readonly manifest: VehicleManifest;
	readonly maxOperations: number;
}

/** Copies Vehicle's readonly JSON shape into Packed's JSON shape. */
function jsonValue(value: VehicleJsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(jsonValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
	}
	return value;
}

/** Preserves Vehicle execution semantics in Packed's effect vocabulary. */
function operationEffects(operation: VehicleManifestOperation): string[] {
	const effects = [`effect:${operation.effect}`, `idempotency:${operation.idempotency.mode}`];
	if (operation.streaming) effects.push("streaming");
	if (operation.longRunning) effects.push("long-running");
	return effects;
}

/** Projects one static Vehicle operation into a host-neutral tool descriptor. */
function operationDescriptor(operation: VehicleManifestOperation): ResolvedAgentToolDescriptor {
	return {
		name: operation.name,
		description: operation.description,
		inputSchema: jsonValue(operation.inputSchema),
		permissions: operation.permissions,
		effects: operationEffects(operation),
		limits: {
			defaultTimeoutMs: operation.limits.defaultTimeoutMs,
			maxTimeoutMs: operation.limits.maxTimeoutMs,
			maxRequestBytes: operation.limits.maxRequestBytes,
			maxResponseBytes: operation.limits.maxResponseBytes,
		},
	};
}

/** Projects one Vehicle manifest into a resolved Packed package. */
function vehiclePackage(input: VehicleAgentToolsLockInput): ResolvedAgentToolPackage {
	const permissions = [...new Set(input.manifest.operations.flatMap((operation) => operation.permissions))];
	return {
		id: input.manifest.name,
		kind: "vehicle",
		source: input.source,
		version: input.manifest.version,
		integrity: input.integrity,
		resources: [{ kind: "vehicle-manifest", path: input.manifestPath }],
		permissions,
		compatibility: [],
		tools: input.manifest.operations.map(operationDescriptor),
	};
}

/** Compiles one bounded Vehicle manifest into Packed's immutable Agent Tools lock. */
export function compileVehicleAgentToolsLock(input: VehicleAgentToolsLockInput): AgentToolsLock {
	if (!Number.isSafeInteger(input.maxOperations) || input.maxOperations < 1) {
		throw new Error("maxOperations must be a positive integer");
	}
	if (input.manifest.operations.length > input.maxOperations) {
		throw new Error(`Vehicle manifest exceeds maxOperations (${input.maxOperations})`);
	}
	const resolvedPackage = vehiclePackage(input);
	return compileAgentToolsLock(
		{
			schemaVersion: 1,
			packages: [{ id: resolvedPackage.id, kind: resolvedPackage.kind, source: resolvedPackage.source }],
		},
		[resolvedPackage],
	);
}
