/**
 * Global vitest teardown — cleans up singletons that keep the process alive.
 *
 * Vitest 4's close() does not force-exit on open handles. The exit() method
 * does, but pre-commit hooks call close(). This teardown mirrors the exit()
 * safety net: an unref'd timer that calls process.exit() after teardownTimeout.
 */

const TEARDOWN_TIMEOUT_MS = 10_000;

export function setup(): void {
	// No-op — teardown is the important part
}

export async function teardown(): Promise<void> {
	try {
		const mod = await import("../../ai/src/session-resources.js");
		(mod as { cleanupSessionResources?: (id?: string) => void }).cleanupSessionResources?.();
	} catch {
		// @dpopsuev/alef-ai not loaded — nothing to clean
	}

	// Safety net: if vitest hangs due to open handles, force exit after timeout.
	// Uses unref() so this timer alone won't keep the process alive.
	// eslint-disable-next-line no-restricted-globals -- vitest teardown must use raw setTimeout for process.exit safety net
	setTimeout(() => {
		process.exit(0); // eslint-disable-line n/no-process-exit -- intentional force-exit after test completion
	}, TEARDOWN_TIMEOUT_MS).unref();
}
