/**
 * Print mode — send one message, let the sink print the reply, exit.
 *
 * The caller owns agent lifecycle. This function only drives the dialog.
 *
 * Used for scripting and pipe composition:
 *   alef -p "What does src/auth.ts export?"
 *   echo "Fix the bug in src/math.ts" | alef
 */

import { formatError } from "./errors.js";
import type { Session } from "./session.js";

const SEND_TIMEOUT_MS = 120_000;

export async function runPrintMode(prompt: string, session: Session): Promise<void> {
	try {
		await session.send?.(prompt, SEND_TIMEOUT_MS);
	} catch (e) {
		console.error(formatError(e));
		process.exitCode = 1;
	} finally {
		session.dispose();
	}
}
