/**
 * Process-local port for in-place reboot / session swap.
 * The bootloader service and ALEF_SUPERVISOR IPC both register here;
 * commands call getRebootPort().
 */

/** Exit code the child sends to the wrapper to request a restart. */
export const RESTART_EXIT_CODE = 75;

/** Handle that triggers an in-place reboot / session swap. */
export interface RebootPort {
	reboot(): Promise<void>;
}

type AlefGlobal = typeof globalThis & {
	alefReboot?: () => void | Promise<void>;
};

let current: RebootPort | undefined;

/** Install or clear the active reboot port; mirrors onto globalThis for legacy callers. */
export function setRebootPort(port: RebootPort | undefined): void {
	current = port;
	const globalRef = globalThis as AlefGlobal;
	if (port) {
		globalRef.alefReboot = () => port.reboot();
	} else {
		delete globalRef.alefReboot;
	}
}

/** Active reboot port, if any. */
export function getRebootPort(): RebootPort | undefined {
	return current;
}
