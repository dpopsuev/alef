/**
 * MemoryOrgan — stage 2 of the llm.phase ordered-pipeline.
 *
 * Stage 1 (ToolShell) injects progressive tool catalog.
 * Stage 2 (this organ) owns context assembly: five-level memory pyramid
 * (Now → Latest → Recent[N] → Session → ROM).
 *
 * Phase 1 skeleton: participates in the pipeline with an empty response.
 * No messages field → mergePhaseResults keeps ToolShell's messages unchanged.
 * prepareStep continues to own context assembly in this phase.
 *
 * Phase 2 (ALE-SPC-55 full): reads SessionStore directly, applies scoring,
 * detects 55% fill, triggers background compaction, replaces prepareStep
 * context assembly via Strangler Fig.
 *
 * Ref: ALE-SPC-55, ALE-TSK-457
 */

import type { BaseOrganOptions } from "@dpopsuev/alef-spine";
import { defineOrgan } from "@dpopsuev/alef-spine";
import type { SessionStore } from "./session-store.js";

export interface MemoryOrganOptions extends BaseOrganOptions {
	/**
	 * Fraction of model context window that triggers background compaction.
	 * Default: 0.55 — leaves headroom for the compaction LLM call itself.
	 */
	compactionThreshold?: number;
	/**
	 * Number of most-recent turns held unconditionally (the Latest level).
	 * Default: 4 — matches recentGuarantee in ContextWindowPolicy.
	 */
	recentGuarantee?: number;
	/**
	 * Session store reference. Required for Phase 2 context assembly.
	 * When absent the organ participates as a no-op pipeline stage.
	 */
	sessionStore?: () => SessionStore | undefined;
}

export function createMemoryOrgan(opts: MemoryOrganOptions = {}) {
	const _compactionThreshold = opts.compactionThreshold ?? 0.55;
	const _recentGuarantee = opts.recentGuarantee ?? 4;

	return defineOrgan(
		"memory",
		{
			"motor/llm.phase": {
				handle: (_ctx: unknown) => {
					// Phase 1: no-op — publish empty phase result so ToolShell's
					// messages survive mergePhaseResults unmodified.
					// Phase 2: read from sessionStore, assemble pyramid, return messages.
					return Promise.resolve({});
				},
			},
		},
		{
			description: "Five-level memory pyramid: Now, Latest, Recent[N], Session, ROM.",
			directives: [],
			...opts,
		},
	);
}
