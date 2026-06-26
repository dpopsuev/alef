export { AgentController, type AgentControllerOptions, type ReplySink } from "./agent-controller.js";
export {
	buildDelegationStack,
	type DelegationAdapters,
	type DelegationStack,
	type DelegationStackOptions,
} from "./delegation.js";
export type { SubagentFactory, SubagentFactoryOptions } from "./in-process.js";
export { InProcessStrategy } from "./in-process.js";
export { RemoteStrategy, type RemoteStrategyOptions } from "./remote-strategy.js";
export {
	buildAdapterDirectives,
	buildBootCatalog,
	createToolShellAdapter,
	type ToolShellOptions,
} from "./tool-catalog.js";
export { Agent, type BusObserver } from "./agent.js";
