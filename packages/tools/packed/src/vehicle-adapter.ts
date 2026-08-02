import {
	type Adapter,
	type CommandActionMap,
	defineAdapter,
	passthroughSchema,
	typedAction,
} from "@dpopsuev/alef-kernel/adapter";
import { CapabilityCommandError } from "@dpopsuev/alef-kernel/capabilities";
import { withLlmContent } from "@dpopsuev/alef-kernel/payload";
import {
	extractVehicleContent,
	type VehicleClient,
	VehicleError,
	type VehicleManifest,
	type VehicleManifestOperation,
} from "@danypops/vehicle-core";
import { copyVehicleJson } from "./vehicle-json.js";

/** Workspace grants and bounds for one Vehicle client projection. */
export interface VehicleAdapterOptions {
	readonly client: VehicleClient;
	readonly permissions: readonly string[];
	readonly maxOperations: number;
	readonly actions?: readonly string[];
}

/** Refuses malformed or oversized manifests before creating model tools. */
export function assertManifestBound(manifest: VehicleManifest, maxOperations: number): void {
	if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) {
		throw new Error("maxOperations must be a positive integer");
	}
	if (manifest.operations.length > maxOperations) {
		throw new Error(`Vehicle manifest exceeds maxOperations (${maxOperations})`);
	}
}

/** Returns true when Workspace grants cover every operation requirement. */
function permissionsSatisfied(required: readonly string[], granted: ReadonlySet<string>): boolean {
	return required.every((permission) => granted.has(permission));
}

/** Copies a Vehicle JSON Schema into Alef's passthrough schema input. */
function vehicleSchema(schema: VehicleManifestOperation["inputSchema"]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, copyVehicleJson(value)]));
}

/** Maps Vehicle's effect taxonomy onto Alef's external-effect boundary. */
function capabilityEffect(operation: VehicleManifestOperation): "none" | "external" {
	return operation.effect === "read" ? "none" : "external";
}

/** Keeps a Vehicle failure machine-readable through Alef's command error channel. */
function invocationFailure(error: unknown): Error {
	if (error instanceof VehicleError) {
		const failure = error.toFailure();
		return new CapabilityCommandError("handler-failed", failure.message, { cause: error, details: failure });
	}
	return error instanceof Error ? error : new Error("Vehicle invocation failed");
}

/** Keeps object progress intact and envelopes primitive progress. */
function progressRecord(progress: unknown): Record<string, unknown> {
	return progress !== null && typeof progress === "object" && !Array.isArray(progress) ? { ...progress } : { progress };
}

/** Applies the Vehicle's default and maximum timeout to the caller's deadline. */
function invocationDeadline(operation: VehicleManifestOperation, requested: number | undefined): number {
	const now = Date.now();
	const defaultDeadline = now + operation.limits.defaultTimeoutMs;
	const maximumDeadline = now + operation.limits.maxTimeoutMs;
	return Math.min(requested ?? defaultDeadline, maximumDeadline);
}

/** Produces model text while retaining the structured Vehicle output. */
function invocationResult(operation: VehicleManifestOperation, output: unknown): Record<string, unknown> {
	const content = extractVehicleContent(output);
	const text = content?.map((block) => block.text).join("\n") ?? JSON.stringify({ output });
	return withLlmContent(
		text,
		{ output },
		{ text: `${operation.name} completed`, mimeType: "text/plain" },
	);
}

/** Builds one Alef command action for an available, granted Vehicle operation. */
function operationAction(client: VehicleClient, operation: VehicleManifestOperation, permissions: readonly string[]) {
	const schema = passthroughSchema(vehicleSchema(operation.inputSchema));
	return typedAction(
		{
			name: operation.name,
			description: operation.description,
			inputSchema: schema,
			outputSchema: passthroughSchema(vehicleSchema(operation.outputSchema)),
			version: operation.version,
			permissions: operation.permissions,
			effect: capabilityEffect(operation),
			...(operation.streaming ? { streaming: true as const } : {}),
			...(operation.longRunning ? { longRunning: true as const } : {}),
		},
		async (context) => {
			try {
				const output = await client.invoke(operation.name, operation.version, context.payload, {
					operationId: context.toolCallId,
					correlationId: context.correlationId,
					signal: context.signal,
					deadline: invocationDeadline(operation, context.deadline),
					permissions,
					onProgress: (progress) => context.reportProgress(progressRecord(progress)),
				});
				return invocationResult(operation, output);
			} catch (error) {
				throw invocationFailure(error);
			}
		},
	);
}

/** Projects one bounded Vehicle manifest into Alef model tools. */
export async function createVehicleAdapter(options: VehicleAdapterOptions): Promise<Adapter> {
	const manifest = await options.client.manifest();
	assertManifestBound(manifest, options.maxOperations);
	const granted = new Set(options.permissions);
	const operations = manifest.operations.filter(
		(operation) => operation.available && permissionsSatisfied(operation.permissions, granted),
	);
	const command: CommandActionMap = Object.fromEntries(
		operations.map((operation) => [operation.name, operationAction(options.client, operation, options.permissions)]),
	);
	const adapter = defineAdapter(
		manifest.name,
		{ command },
		{
			actions: options.actions,
			description: manifest.description,
			directives:
				manifest.guidance && manifest.guidance.length > 0
					? manifest.guidance
					: [`Use ${manifest.name} operations for ${manifest.description.toLowerCase()}.`],
		},
	);
	return { ...adapter, close: () => options.client.close() };
}
