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
export { type CodeIntelOrganOptions, createCodeIntelOrgan } from "./organ.js";

import type { Organ, OrganLogger } from "@dpopsuev/alef-kernel";
import { createCodeIntelOrgan } from "./organ.js";
export function createOrgan(opts: { cwd: string; actions?: string[]; logger?: OrganLogger }): Organ {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `code.${a}`));
	return createCodeIntelOrgan({ cwd: opts.cwd, actions });
}
export { StubLectorBackend } from "./stub-backend.js";
export { extractBlock, extractSymbols } from "./symbol-extractor.js";
