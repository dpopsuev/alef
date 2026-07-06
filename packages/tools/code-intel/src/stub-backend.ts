/**
 * StubCodeIntelBackend — no-op backend for tests.
 *
 * Returns empty results for all LSP operations.
 * Used when testing adapter structure without real LSP integration.
 */

import type { CallersOptions, CallSite, CodeIntelBackend, Diagnostic, HoverInfo, WorkspaceSymbol } from "./backend.js";

export class StubCodeIntelBackend implements CodeIntelBackend {
	async callers(_symbol: string, _opts: CallersOptions = {}): Promise<CallSite[]> {
		return [];
	}

	async getDiagnostics(_path: string): Promise<Diagnostic[]> {
		return [];
	}

	async getHover(_path: string, _line: number, _character: number): Promise<HoverInfo | null> {
		return null;
	}

	async workspaceSymbols(_query: string): Promise<WorkspaceSymbol[]> {
		return [];
	}
}
