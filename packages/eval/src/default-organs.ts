/**
 * Default base organ set for EvalHarness.
 *
 * Exported so callers can extend or replace the defaults:
 *   baseOrgansFactory: (cwd) => [...defaultEvalOrgans(cwd), myOrgan]
 *
 * Or suppress them entirely:
 *   baseOrgansFactory: () => []
 */

import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import type { Organ } from "@dpopsuev/alef-spine";

export function defaultEvalOrgans(workspace: string): Organ[] {
	return [createFsOrgan({ cwd: workspace }), createShellOrgan({ cwd: workspace })];
}
