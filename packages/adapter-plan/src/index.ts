export { createPlanOrgan, type PlanOrganOptions } from "./adapter.js";
export { type Phase, type PlanData, PlanGraph, type PlanNode } from "./graph.js";

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createPlanOrgan } from "./adapter.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Adapter {
	return createPlanOrgan({ sessionDir: opts.sessionDir ?? opts.cwd });
}
