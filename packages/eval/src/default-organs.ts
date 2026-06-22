/**
 * Default base organ set for EvalHarness.
 *
 * Exported so callers can extend or replace the defaults:
 *   baseOrgansFactory: (cwd) => [...defaultEvalOrgans(cwd), myOrgan]
 *
 * Or suppress them entirely:
 *   baseOrgansFactory: () => []
 */

import { createFsOrgan } from "@dpopsuev/alef-adapter-fs";
import { createShellOrgan } from "@dpopsuev/alef-adapter-shell";
import type { Adapter } from "@dpopsuev/alef-kernel";

export function defaultEvalOrgans(workspace: string): Adapter[] {
	return [createFsOrgan({ cwd: workspace }), createShellOrgan({ cwd: workspace })];
}
