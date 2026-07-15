/**
 * Process-local port for in-place rebuild / session swap.
 * Hot-reload and ALEF_SUPERVISOR IPC both register here; commands call getRebuildPort().
 */

/** Handle that triggers an in-place rebuild / session swap. */
export interface RebuildPort {
	requestRebuild(): Promise<void>;
}

type AlefGlobal = typeof globalThis & {
	alefRequestRebuild?: () => void | Promise<void>;
};

let current: RebuildPort | undefined;

/** Install or clear the active rebuild port; mirrors onto globalThis for legacy callers. */
export function setRebuildPort(port: RebuildPort | undefined): void {
	current = port;
	const globalRef = globalThis as AlefGlobal;
	if (port) {
		globalRef.alefRequestRebuild = () => port.requestRebuild();
	} else {
		delete globalRef.alefRequestRebuild;
	}
}

/** Active rebuild port, if any. */
export function getRebuildPort(): RebuildPort | undefined {
	return current;
}
