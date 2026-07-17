/**
 * Code Intelligence Adapter — LSP + tree-sitter graph for TypeScript/JavaScript.
 */

export {
	type CodeIntelAdapterOptions,
	createCodeIntelAdapter,
	createCodeIntelAdapter as createAdapter,
} from "./adapter.js";
export type {
	CallersOptions,
	CallSite,
	CodeIntelBackend,
	Diagnostic,
	HoverInfo,
	WorkspaceSymbol,
} from "./backend.js";
export { LocalCodeIntelBackend, type LocalCodeIntelBackendOptions } from "./local-backend.js";
export { StubCodeIntelBackend } from "./stub-backend.js";
export { GraphBackend, type GraphBackendOptions } from "./graph-backend.js";
export { WorkspaceIndexer, defaultGraphDbPath, type IndexerOptions } from "./indexer.js";
export { service } from "./service.js";
