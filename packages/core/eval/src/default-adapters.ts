/**
 * Default base adapter set for EvalHarness.
 *
 * Exported so callers can extend or replace the defaults:
 *   baseAdaptersFactory: (cwd) => [...defaultEvalAdapters(cwd), myAdapter]
 *
 * Or suppress them entirely:
 *   baseAdaptersFactory: () => []
 */

// eslint-disable-next-line no-restricted-imports -- eval harness is a composition root; needs concrete adapters
import { createFsAdapter } from "@dpopsuev/alef-tool-fs";
// eslint-disable-next-line no-restricted-imports -- eval harness is a composition root; needs concrete adapters
import { createShellAdapter } from "@dpopsuev/alef-tool-shell";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";

export function defaultEvalAdapters(workspace: string): Adapter[] {
	return [createFsAdapter({ cwd: workspace }), createShellAdapter({ cwd: workspace })];
}
