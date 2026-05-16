/**
 * Print mode — send one message, let the sink print the reply, exit.
 *
 * The caller owns agent lifecycle. This function only drives the dialog.
 *
 * Used for scripting and pipe composition:
 *   alef -p "What does src/auth.ts export?"
 *   echo "Fix the bug in src/math.ts" | alef
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { formatError } from "./errors.js";

const SEND_TIMEOUT_MS = 120_000; // 2 min — Vertex latency can exceed 30s

export async function runPrintMode(prompt: string, dialog: DialogOrgan, dispose: () => void): Promise<void> {
	try {
		// sink in main.ts handles output — await here ensures completion before dispose.
		await dialog.send(prompt, "human", SEND_TIMEOUT_MS);
	} catch (e) {
		console.error(formatError(e));
		process.exitCode = 1;
	} finally {
		dispose();
	}
}
