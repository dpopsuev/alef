/**
 * Vitest 4 force-exit reporter.
 *
 * Vitest 4's pool.close() hangs when worker threads don't respond to the
 * stop message (vitest-dev/vitest#8766). The hang blocks ALL teardown hooks
 * (globalSetup teardown, reporter onFinished) because the pool hang occurs
 * in Vitest.close() before these hooks complete.
 *
 * Mitigation: the pre-commit hook wraps vitest with `timeout 120` and treats
 * exit code 124 as a warning. This file is a no-op placeholder documenting
 * the issue until vitest fixes the underlying pool shutdown bug.
 *
 * See: https://github.com/angular/angular-cli/issues/32832
 * See: https://github.com/vitest-dev/vitest/issues/8766
 */

/**
 *
 */
export default class ForceExitReporter {
	onProcessTimeout(): void {
		process.exitCode = 1;
	}
}
