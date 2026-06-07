/**
 * CodingAgentHarness testkit entry point.
 *
 * Provides the production organ set and materializer for use in eval tests,
 * closing the gap between what ships and what is tested.
 *
 * Usage in eval tests:
 *   import { materializeDefaultOrgans } from '@dpopsuev/alef-coding-agent/testkit';
 *   // returns Organ[] matching the production blueprint
 *   const organs = await materializeDefaultOrgans(cwd);
 *
 * Full CodingAgentHarness wrapping EvalHarness is tracked in ALE-TSK-707.
 */

import type { Organ } from "@dpopsuev/alef-kernel";
import { CODING_AGENT_BLUEPRINT } from "./blueprint.js";
import { materializeBlueprint } from "./materializer.js";

export { CODING_AGENT_BLUEPRINT } from "./blueprint.js";
export { materializeBlueprint } from "./materializer.js";

/**
 * Materialize the default coding agent organ set for use in eval harness tests.
 * Equivalent to the organs loaded in production by local-session.ts.
 */
export async function materializeDefaultOrgans(cwd: string): Promise<Organ[]> {
	const { organs } = await materializeBlueprint(CODING_AGENT_BLUEPRINT, { cwd });
	return organs;
}
