export {
	InMemoryToolResultCache,
	type InMemoryToolResultCacheOptions,
	NoopToolResultCache,
	type ToolResultCache,
	type ToolResultCacheHit,
} from "./cache.js";
export {
	DEFAULT_FIND_LIMIT,
	DEFAULT_GREP_LIMIT,
	DEFAULT_LS_LIMIT,
	executeFindQuery,
	executeGrepQuery,
	executeLsQuery,
	type FindOperations,
	type FindQueryOptions,
	type FindToolDetails,
	type FindToolInput,
	type FindToolResponse,
	type GrepOperations,
	type GrepQueryOptions,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolResponse,
	type LsOperations,
	type LsQueryOptions,
	type LsToolDetails,
	type LsToolInput,
	type LsToolResponse,
} from "./file-queries.js";
export { type FsCacheScope, FsRuntime, type FsRuntimeOptions } from "./fs-runtime.js";
// Standard factory entry point for the materializer's dynamic-load protocol.
// Receives { cwd, actions?, logger? } from the blueprint; ignores unknown fields.
export { createFsOrgan, type FsOrganOptions } from "./organ.js";

import type { Organ, OrganLogger } from "@dpopsuev/alef-kernel";
import { createFsOrgan } from "./organ.js";
/** Standard materializer entry point. Maps short names ("read") to full event types ("fs.read"). */
export function createOrgan(opts: { cwd: string; actions?: string[]; logger?: OrganLogger }): Organ {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `fs.${a}`));
	return createFsOrgan({ ...opts, actions });
}
export { assertWithinRoots, guardedResolve, type PathGuardOptions } from "./path-guard.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";
