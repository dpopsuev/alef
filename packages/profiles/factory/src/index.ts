import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { createFactoryAgentStack } from "./blueprint.js";

blueprintRegistry.register("alef-factory-agent", createFactoryAgentStack);

export { createFactoryAgentStack };
export type { BlueprintStack, BlueprintStackOptions } from "./blueprint.js";
