/**
 * StubCodeIntelBackend — no-op backend for tests.
 *
 * Returns empty results for all LSP operations.
 * Used when testing adapter structure without real LSP integration.
 */

import type { CallersOptions, CallSite, CodeIntelBackend, Diagnostic, HoverInfo, WorkspaceSymbol } from "./backend.js";

/**
 *
 */
export class StubCodeIntelBackend implements CodeIntelBackend {
	// eslint-disable-next-line @typescript-eslint/require-await
	async callers(_symbol: string, _opts: CallersOptions = {}): Promise<CallSite[]> {
		return [];
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async getDiagnostics(_path: string): Promise<Diagnostic[]> {
		return [];
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async getHover(_path: string, _line: number, _character: number): Promise<HoverInfo | null> {
		return null;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async workspaceSymbols(_query: string): Promise<WorkspaceSymbol[]> {
		return [];
	}
}
