import type { Organ, OrganBus, OrganResult } from "@dpopsuev/alef-nerve";
import {
	DEFAULT_FIND_LIMIT,
	DEFAULT_GREP_LIMIT,
	DEFAULT_LS_LIMIT,
	executeFindQuery,
	executeGrepQuery,
	executeLsQuery,
	type FindToolInput,
	type GrepToolInput,
	type LsToolInput,
} from "./file-queries.js";
import type { FsCacheScope, FsRuntime } from "./fs-runtime.js";

// ---------------------------------------------------------------------------
// FsOrgan — the filesystem organ.
//
// Subscribes to organ.invoke.v1 events where organ === "fs" and dispatches
// to the appropriate query executor (grep, find, ls).
//
// The organ never calls back into the corpus. All communication goes through
// the OrganBus. If the organ is not mounted, the bus will throw an explicit
// error rather than silently bypassing the action.
// ---------------------------------------------------------------------------

export interface FsOrganOptions {
	/** Working directory for relative path resolution. */
	cwd: string;
	/**
	 * Optional FsRuntime providing per-scope caches (grep, find, ls).
	 * When omitted, queries run without caching.
	 */
	runtime?: FsRuntime;
}

function getCache(runtime: FsRuntime | undefined, scope: FsCacheScope) {
	return runtime?.getCache(scope);
}

function contentLength(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
}

async function handleGrep(args: Record<string, unknown>, opts: FsOrganOptions): Promise<OrganResult> {
	const input: GrepToolInput = {
		pattern: String(args.pattern ?? ""),
		path: args.path !== undefined ? String(args.path) : undefined,
		glob: args.glob !== undefined ? String(args.glob) : undefined,
		ignoreCase: Boolean(args.ignoreCase ?? false),
		literal: Boolean(args.literal ?? false),
		context: typeof args.context === "number" ? args.context : 0,
		limit: typeof args.limit === "number" ? args.limit : DEFAULT_GREP_LIMIT,
	};
	const response = await executeGrepQuery(input, {
		cwd: opts.cwd,
		cache: getCache(opts.runtime, "grep"),
	});
	const isError = response.content.length === 0 && !response.details;
	return {
		ok: !isError,
		content: response,
		contentLength: contentLength(response),
	};
}

async function handleFind(args: Record<string, unknown>, opts: FsOrganOptions): Promise<OrganResult> {
	const input: FindToolInput = {
		pattern: String(args.pattern ?? ""),
		path: args.path !== undefined ? String(args.path) : undefined,
		limit: typeof args.limit === "number" ? args.limit : DEFAULT_FIND_LIMIT,
	};
	const response = await executeFindQuery(input, {
		cwd: opts.cwd,
		cache: getCache(opts.runtime, "find"),
	});
	return {
		ok: true,
		content: response,
		contentLength: contentLength(response),
	};
}

async function handleLs(args: Record<string, unknown>, opts: FsOrganOptions): Promise<OrganResult> {
	const input: LsToolInput = {
		path: args.path !== undefined ? String(args.path) : ".",
		limit: typeof args.limit === "number" ? args.limit : DEFAULT_LS_LIMIT,
	};
	const response = await executeLsQuery(input, {
		cwd: opts.cwd,
		cache: getCache(opts.runtime, "ls"),
	});
	return {
		ok: true,
		content: response,
		contentLength: contentLength(response),
	};
}

/**
 * Create the filesystem organ.
 *
 * @example
 * ```typescript
 * import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
 * import { InProcessOrganBus, MemLog } from "@dpopsuev/alef-nerve";
 *
 * const log = new MemLog();
 * const bus = new InProcessOrganBus(log);
 * const unmount = createFsOrgan({ cwd: process.cwd() }).mount(bus);
 *
 * const result = await bus.invoke("fs", "grep", { pattern: "TODO" });
 * console.log(result.content);
 *
 * unmount();
 * ```
 */
export function createFsOrgan(options: FsOrganOptions): Organ {
	return {
		name: "fs",
		actions: ["grep", "find", "ls"],

		mount(bus: OrganBus): () => void {
			return bus.handle("fs", async (action, args) => {
				switch (action) {
					case "grep":
						return handleGrep(args, options);
					case "find":
						return handleFind(args, options);
					case "ls":
						return handleLs(args, options);
					default:
						return {
							ok: false,
							content: null,
							contentLength: 0,
							error: `fs organ: unknown action "${action}". Supported: grep, find, ls.`,
						};
				}
			});
		},
	};
}
