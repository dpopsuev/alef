/**
 * Code Intelligence Adapter — LSP-based TypeScript/JavaScript code intelligence.
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
export { service } from "./service.js";
