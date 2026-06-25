import { blueprintRegistry } from "@dpopsuev/alef-blueprint";
import { createFactoryAgentStack } from "./blueprint.js";

blueprintRegistry.register("alef-factory-agent", createFactoryAgentStack);

export { createFactoryAgentStack };
export type { BlueprintStack, BlueprintStackOptions } from "./blueprint.js";
