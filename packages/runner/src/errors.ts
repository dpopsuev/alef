/**
 * Error formatting for the runner — turns raw errors into human-readable messages.
 *
 * Per-turn errors must not crash the session. Print and continue.
 *
 * @deprecated Use formatErrorForUser from "@dpopsuev/alef-kernel/errors" instead.
 * Kept for backward compatibility during migration.
 */

import { formatErrorForUser } from "@dpopsuev/alef-kernel";

export function formatError(e: unknown): string {
	return formatErrorForUser(e);
}
