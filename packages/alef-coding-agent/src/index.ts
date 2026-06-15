import { blueprintRegistry } from "@dpopsuev/alef-agent-blueprint";
import { createCodingAgentStack } from "./blueprint.js";

blueprintRegistry.register("alef-coding-agent", createCodingAgentStack, { isDefault: true });

export { createCodingAgentStack };
export type { BlueprintStack, BlueprintStackOptions } from "./blueprint.js";
