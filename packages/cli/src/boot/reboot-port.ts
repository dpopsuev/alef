/**
 * Restart abstractions.
 *
 * RebootPort: "prepare for restart" (build new code). Optional -- prod has none.
 * RestartStrategy: "execute the restart" (exit, fork, IPC). Always present.
 */

/** Exit code the child sends to the wrapper to request a restart. */
export const RESTART_EXIT_CODE = 75;

/** Prepare for restart -- typically runs the build step. */
export interface RebootPort {
	reboot(): Promise<void>;
}

/** Execute the actual process restart. Injected through context. */
export interface RestartStrategy {
	restart(): Promise<never>;
}

/** RestartStrategy that exits with RESTART_EXIT_CODE for the wrapper to catch. */
export function createExitRestartStrategy(): RestartStrategy {
	return {
		restart(): Promise<never> {
			process.exit(RESTART_EXIT_CODE);
		},
	};
}

type AlefGlobal = typeof globalThis & {
	alefReboot?: () => void | Promise<void>;
};

let currentPort: RebootPort | undefined;
let currentStrategy: RestartStrategy | undefined;

/**
 *
 */
export function setRebootPort(port: RebootPort | undefined): void {
	currentPort = port;
	const globalRef = globalThis as AlefGlobal;
	if (port) {
		globalRef.alefReboot = () => port.reboot();
	} else {
		delete globalRef.alefReboot;
	}
}

/**
 *
 */
export function getRebootPort(): RebootPort | undefined {
	return currentPort;
}

/**
 *
 */
export function setRestartStrategy(strategy: RestartStrategy | undefined): void {
	currentStrategy = strategy;
}

/**
 *
 */
export function getRestartStrategy(): RestartStrategy | undefined {
	return currentStrategy;
}
