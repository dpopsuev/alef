export type {
	ContextAssemblyHandler,
	ContextAssemblyInput,
	ContextAssemblyOutput,
	PortCardinality,
	PortDefinition,
} from "./adapter/contributions.js";
export { createContextAssemblyPipeline } from "./pipeline/assembly.js";
export { injectContextBlock } from "./pipeline/helpers.js";
