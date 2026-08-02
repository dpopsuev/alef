import { createVehicleAdapter } from "@danypops/alef-packed";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { MaterializerOptions } from "@dpopsuev/alef-blueprint/materializer";
import type { AlefConfig } from "./config.js";

/** Rejects plaintext Vehicle credentials outside loopback. */
function assertSafeVehicleUrl(baseUrl: string, name: string): void {
	const url = new URL(baseUrl);
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(`Vehicle '${name}' requires HTTPS outside loopback`);
	}
}

/** Resolves Blueprint Vehicle names against host-owned connections and credentials. */
export function createVehicleResolver(
	config: AlefConfig,
	environment: NodeJS.ProcessEnv = process.env,
): NonNullable<MaterializerOptions["resolveVehicle"]> {
	return async (vehicle) => {
		const binding = config.vehicles?.[vehicle.name];
		if (!binding) throw new Error(`Vehicle '${vehicle.name}' has no connection binding`);
		assertSafeVehicleUrl(binding.base_url, vehicle.name);
		const token = environment[binding.token_env];
		if (!token) throw new Error(`Vehicle '${vehicle.name}' credential '${binding.token_env}' is not set`);
		const client = new RemoteVehicleClient({ baseUrl: binding.base_url, token });
		return [
			await createVehicleAdapter({
				client,
				maxOperations: vehicle.maxOperations,
				permissions: vehicle.permissions,
			}),
		];
	};
}
