export type {
	CallersOptions,
	CallSite,
	EditSpec,
	FindOptions,
	LectorBackend,
	ReadOptions,
	ReadResult,
	SearchMatch,
	SearchOptions,
	SymbolBlock,
	SymbolKind,
} from "./backend.js";
export { BlockCache, type CacheEntry } from "./block-cache.js";
export { LocalLectorBackend, type LocalLectorBackendOptions } from "./local-backend.js";
export { createLectorOrgan, type LectorOrganOptions } from "./organ.js";

import type { Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { createLectorOrgan } from "./organ.js";
export function createOrgan(opts: { cwd: string; actions?: string[]; logger?: OrganLogger }): Organ {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `lector.${a}`));
	return createLectorOrgan({ cwd: opts.cwd, actions });
}
export { StubLectorBackend } from "./stub-backend.js";
export { extractBlock, extractSymbols } from "./symbol-extractor.js";
