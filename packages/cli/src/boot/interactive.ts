/**
 * Interactive mode -- read lines from stdin, send each to the agent, print replies.
 *
 * The caller owns agent lifecycle. This function only drives the dialog loop.
 *
 * Type /exit or press Ctrl+D to quit.
 * Conversation history accumulates across turns.
 */

import { formatErrorForUser } from "@dpopsuev/alef-kernel/errors";
import type { Session } from "@dpopsuev/alef-session/contracts";
import { readStdinLines } from "./readline.js";

export type { InteractiveOptions } from "../client/boot-types.js";

import type { InteractiveOptions } from "../client/boot-types.js";

const EXIT_COMMAND = "/exit";

/** Drive a read-eval-print loop over stdin, sending each line to the session. */
export async function runInteractive(session: Session, opts: InteractiveOptions): Promise<void> {
	if (process.stdin.isTTY) {
		console.log(`Alef agent ready. Working directory: ${opts.cwd}`);
		console.log(`Model: ${opts.modelId}`);
		console.log(`Type ${EXIT_COMMAND} or Ctrl+D to quit.\n`);
	}

	try {
		for await (const line of readStdinLines()) {
			if (line === EXIT_COMMAND) break;
			try {
				await session.send?.(line, 120_000);
			} catch (e) {
				console.error(formatErrorForUser(e));
			}
			if (process.stdin.isTTY) {
				console.log();
			}
		}
	} finally {
		void session.dispose();
	}
}
