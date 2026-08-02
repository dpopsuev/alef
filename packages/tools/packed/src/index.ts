import {
	compileAgentToolsLock,
	type AgentToolsLock,
	type ResolvedAgentToolDescriptor,
	type ResolvedAgentToolPackage,
} from "@danypops/packed/agent-tools";
import type { VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import { assertManifestBound } from "./vehicle-adapter.js";
import { copyVehicleJson } from "./vehicle-json.js";

export { assertManifestBound, createVehicleAdapter, type VehicleAdapterOptions } from "./vehicle-adapter.js";

/** Inputs needed to lock one static Vehicle manifest. */
export interface VehicleAgentToolsLockInput {
	readonly source: string;
	readonly integrity: string;
	readonly manifestPath: string;
	readonly manifest: VehicleManifest;
	readonly maxOperations: number;
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
		inputSchema: copyVehicleJson(operation.inputSchema),
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
	assertManifestBound(input.manifest, input.maxOperations);
	const resolvedPackage = vehiclePackage(input);
	return compileAgentToolsLock(
		{
			schemaVersion: 1,
			packages: [{ id: resolvedPackage.id, kind: resolvedPackage.kind, source: resolvedPackage.source }],
		},
		[resolvedPackage],
	);
}
