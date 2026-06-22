export * from "./blueprints.js";
export * from "./bootstrap.js";
export type { AdapterFactoryOptions as OrganFactoryOptions } from "./materializer.js";
export * from "./materializer.js";
// ── Backward-compat aliases (organ → adapter) ────────────────────────
export {
	loadAdapterFromPath as loadOrganFromPath,
	loadUserAdaptersConfig as loadUserOrgansConfig,
	materializeDefaultAdapters as materializeDefaultOrgans,
	userAdaptersConfigPath as userOrgansConfigPath,
} from "./materializer.js";
export * from "./organs.js";
export * from "./registry.js";
export * from "./types.js";
