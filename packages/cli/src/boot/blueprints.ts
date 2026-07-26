import { existsSync } from "node:fs";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";

/** Resolve a blueprint name or file path to a registry entry or existing file path. */
export function resolveBlueprint(nameOrPath: string, _cwd?: string): string | undefined {
	if (blueprintRegistry.list().includes(nameOrPath)) return nameOrPath;
	if (existsSync(nameOrPath)) return nameOrPath;
	return undefined;
}
