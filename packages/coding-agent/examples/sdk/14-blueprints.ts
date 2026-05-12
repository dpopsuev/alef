/**
 * Minimal blueprint-driven session.
 *
 * Loads `examples/platform/agent.yaml`, which gives the root session the
 * built-in supervisor capability plus one child blueprint named `reviewer`.
 */

import { createAgentSession, SessionManager } from "@dpopsuev/alef-coding-agent";

const blueprint = new URL("../platform/agent.yaml", import.meta.url).pathname;

const { session } = await createAgentSession({
	blueprint,
	sessionManager: SessionManager.inMemory(),
});

console.log(`role=${session.platform.role}`);
console.log(`actions=${session.platform.actions.map((action) => action.name).join(", ")}`);
console.log(
	`organs=${session.agentDefinition?.organs.map((organ) => `${organ.name}:${organ.actions.join("+")}`).join(", ") ?? "(none)"}`,
);
console.log(`children=${session.agentDefinition?.children.map((child) => child.name).join(", ") ?? "(none)"}`);
console.log(`contracts=${session.platform.discourse.listContracts().length}`);
