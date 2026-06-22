export { type Phase, type PlanData, PlanGraph, type PlanNode } from "./graph.js";
export { createPlanOrgan, type PlanOrganOptions } from "./organ.js";

import type { Adapter } from "@dpopsuev/alef-kernel";
import { createPlanOrgan } from "./organ.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Adapter {
	return createPlanOrgan({ sessionDir: opts.sessionDir ?? opts.cwd });
}
