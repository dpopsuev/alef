/**
 * @dpopsuev/alef-coding-agent
 *
 * The Alef coding agent as a publishable, testable module.
 *
 * Public API surface — everything below this line is stable:
 *   createCodingAgent(config)  — production agent session
 *   materializeBlueprint       — organ materializer (re-exported for testkit)
 *
 * Internals (ToolShell, LlmPipeline, DelegateOrgan, organ wiring) are hidden.
 */

export { CODING_AGENT_BLUEPRINT } from "./blueprint.js";
export { materializeBlueprint } from "./materializer.js";
export type { CodingAgentConfig, CodingAgentSession } from "./session.js";
export { createCodingAgent } from "./session.js";
