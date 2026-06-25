/**
 * Default base adapter set for EvalHarness.
 *
 * Exported so callers can extend or replace the defaults:
 *   baseAdaptersFactory: (cwd) => [...defaultEvalAdapters(cwd), myAdapter]
 *
 * Or suppress them entirely:
 *   baseAdaptersFactory: () => []
 */

import { createFsAdapter } from "@dpopsuev/alef-tool-fs";
import { createShellAdapter } from "@dpopsuev/alef-tool-shell";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";

export function defaultEvalAdapters(workspace: string): Adapter[] {
	return [createFsAdapter({ cwd: workspace }), createShellAdapter({ cwd: workspace })];
}
