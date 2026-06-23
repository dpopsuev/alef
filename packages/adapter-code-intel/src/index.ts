/**
 * Code Intelligence Adapter — LSP-based TypeScript/JavaScript code intelligence.
 */

export { type CodeIntelOrganOptions, createCodeIntelOrgan } from "./adapter.js";
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

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createCodeIntelOrgan } from "./adapter.js";

export function createOrgan(opts: { cwd: string; actions?: string[] }): Adapter {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `code.${a}`));
	return createCodeIntelOrgan({ cwd: opts.cwd, actions });
}
export { createCodeIntelOrgan as createCodeIntelAdapter } from "./adapter.js";
