/**
 * Print mode — send one message, print the reply, exit.
 *
 * Used for scripting and pipe composition:
 *   alef -p "What does src/auth.ts export?"
 *   echo "Fix the bug in src/math.ts" | alef
 */

import type { BootOptions } from "./boot.js";
import { bootAgent } from "./boot.js";

export async function runPrintMode(prompt: string, opts: BootOptions): Promise<void> {
	const session = bootAgent(opts);
	try {
		// sink in boot.ts handles output — await here just ensures completion before dispose.
		await session.dialog.send(prompt);
	} finally {
		session.dispose();
	}
}
