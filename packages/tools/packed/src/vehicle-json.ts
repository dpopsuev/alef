import type { JsonValue as PackedJsonValue } from "@danypops/packed/agent-tools";
import type { JsonValue as VehicleJsonValue } from "@danypops/vehicle-core";

/** Copies Vehicle's readonly JSON shape into Packed's host-neutral JSON shape. */
export function copyVehicleJson(value: VehicleJsonValue): PackedJsonValue {
	if (Array.isArray(value)) return value.map(copyVehicleJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyVehicleJson(child)]));
	}
	return value;
}
