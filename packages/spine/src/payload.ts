/**
 * Typed payload accessors for Record<string, unknown> event payloads.
 *
 * Every bus event payload is Record<string, unknown>. These helpers narrow a
 * field to the expected primitive type, returning undefined (or a provided
 * default) when the field is absent or the wrong type.
 *
 * Eliminates the 39-occurrence pattern of:
 *   typeof ctx.payload.path === "string" ? ctx.payload.path : ""
 *
 * Usage:
 *   import { getString, getNumber, getBoolean } from "@dpopsuev/alef-spine";
 *   const path = getString(ctx.payload, "path") ?? "";
 *   const limit = getNumber(ctx.payload, "limit");
 *   const hidden = getBoolean(ctx.payload, "hidden") ?? false;
 */

export function getString(payload: Record<string, unknown>, key: string): string | undefined {
	const v = payload[key];
	return typeof v === "string" ? v : undefined;
}

export function getNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const v = payload[key];
	return typeof v === "number" ? v : undefined;
}

export function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const v = payload[key];
	return typeof v === "boolean" ? v : undefined;
}
