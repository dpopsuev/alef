/**
 * StubCodeIntelBackend — no-op backend for tests.
 *
 * Returns empty results for all LSP operations.
 * Used when testing organ structure without real LSP integration.
 */

import type { CallersOptions, CallSite, CodeIntelBackend } from "./backend.js";

export class StubCodeIntelBackend implements CodeIntelBackend {
	async callers(_symbol: string, _opts: CallersOptions = {}): Promise<CallSite[]> {
		return [];
	}

	async getDiagnostics(_path: string): Promise<import("./backend.js").Diagnostic[]> {
		return [];
	}

	async getHover(_path: string, _line: number, _character: number): Promise<import("./backend.js").HoverInfo | null> {
		return null;
	}

	async workspaceSymbols(_query: string): Promise<import("./backend.js").WorkspaceSymbol[]> {
		return [];
	}
}
