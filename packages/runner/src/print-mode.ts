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

export async function runPrintMode(prompt: string, dialog: DialogOrgan, dispose: () => void): Promise<void> {
	try {
		// sink in main.ts handles output — await here ensures completion before dispose.
		await dialog.send(prompt);
	} finally {
		dispose();
	}
}
