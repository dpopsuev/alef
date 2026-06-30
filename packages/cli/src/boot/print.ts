/**
 * Print mode — send one message, let the sink print the reply, exit.
 *
 * The caller owns agent lifecycle. This function only drives the dialog.
 *
 * Used for scripting and pipe composition:
 *   alef -p "What does src/auth.ts export?"
 *   echo "Fix the bug in src/math.ts" | alef
 */

import { formatErrorForUser } from "@dpopsuev/alef-kernel/errors";
import type { Session } from "@dpopsuev/alef-session/contracts";

const SEND_TIMEOUT_MS = 120_000;

/** Send a single prompt to the session, print the reply, and exit. */
export async function runPrintMode(prompt: string, session: Session): Promise<void> {
	try {
		await session.send?.(prompt, SEND_TIMEOUT_MS);
	} catch (e) {
		console.error(formatErrorForUser(e));
		process.exitCode = 1;
	} finally {
		session.dispose();
	}
}
