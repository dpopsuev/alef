/**
 * LectorRuntime — legacy stub for coding-agent symbol tools.
 *
 * The pi-mono symbol tools (symbol-graph, symbol-outline) use LectorRuntime
 * for optional LSP/TreeSitter-accelerated cache management. In practice the
 * runtime is wired but the cache hits/misses are just logging calls.
 *
 * The new EDA LectorOrgan (packages/organ-lector) replaces this entirely.
 * This class is a minimal no-op stub that satisfies the coding-agent's call
 * sites without pulling in the old @dpopsuev/alef-agent-runtime dependency.
 *
 * Delete this file when the coding-agent is drained in favour of the runner.
 */

import type { EventInput } from "../board/event-log.js";

export interface LectorRuntimeConfig {
	lsp: { enabled: boolean; command: string };
	treeSitter: { enabled: boolean };
	indexing: { preload: "none" | "workspace" };
}

export type LectorRuntimeConfigInput = Partial<LectorRuntimeConfig>;
export type LectorCacheScope = "doc" | "ast" | "outline" | "graph" | "query";

export interface LectorRuntimeOptions {
	cwd: string;
	cacheTtlMs: number;
	cacheMaxEntries: number;
	cacheEnabled?: boolean;
	runtimeConfig?: LectorRuntimeConfigInput;
	emitDomainEvent?: (event: EventInput) => void;
}

export const DEFAULT_LECTOR_RUNTIME_CONFIG: LectorRuntimeConfig = {
	lsp: { enabled: false, command: "typescript-language-server" },
	treeSitter: { enabled: false },
	indexing: { preload: "none" },
};

/** No-op stub — all methods are safe to call and do nothing. */
export class LectorRuntime {
	// biome-ignore lint/complexity/noUselessConstructor: stub accepts agent-session options
	constructor(_opts?: LectorRuntimeOptions) {}

	get config(): LectorRuntimeConfig {
		return DEFAULT_LECTOR_RUNTIME_CONFIG;
	}

	getCache(_scope: LectorCacheScope): undefined {
		return undefined;
	}

	recordCacheHit(_scope: LectorCacheScope, _key: string, _ageMs: number, _ttlMs: number): void {}
	recordCacheMiss(_scope: LectorCacheScope, _key: string): void {}
	recordIndexUpdated(_stage: string, _data: Record<string, unknown>): void {}
	recordError(_stage: string, _error: unknown, _details?: Record<string, unknown>): void {}

	async ensureBootstrapped(): Promise<{ lspReady: boolean; treeSitterReady: boolean }> {
		return { lspReady: false, treeSitterReady: false };
	}
}
