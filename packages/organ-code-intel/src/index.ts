/**
 * Code Intelligence Organ — LSP-based TypeScript/JavaScript code intelligence.
 */

export type {
	CallersOptions,
	CallSite,
	CodeIntelBackend,
	Diagnostic,
	HoverInfo,
	WorkspaceSymbol,
} from "./backend.js";

export { LocalCodeIntelBackend, type LocalCodeIntelBackendOptions } from "./local-backend.js";

export { type CodeIntelOrganOptions, createCodeIntelOrgan } from "./organ.js";

export { StubCodeIntelBackend } from "./stub-backend.js";

import type { Organ } from "@dpopsuev/alef-kernel";
import { createCodeIntelOrgan } from "./organ.js";

export function createOrgan(opts: { cwd: string; actions?: string[] }): Organ {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `code.${a}`));
	return createCodeIntelOrgan({ cwd: opts.cwd, actions });
}
