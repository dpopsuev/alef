/**
 * Interactive mode — read lines from stdin, send each to the agent, print replies.
 *
 * Type /exit or press Ctrl+D to quit.
 * Conversation history accumulates across turns (DialogOrgan.history).
 */

import type { BootOptions } from "./boot.js";
import { bootAgent } from "./boot.js";
import { readStdinLines } from "./stdin.js";

const EXIT_COMMAND = "/exit";

export async function runInteractive(opts: BootOptions): Promise<void> {
	const session = bootAgent(opts);

	if (process.stdin.isTTY) {
		console.log(`Alef agent ready. Working directory: ${opts.cwd}`);
		console.log(`Model: ${opts.model.id}`);
		console.log(`Type ${EXIT_COMMAND} or Ctrl+D to quit.\n`);
	}

	try {
		for await (const line of readStdinLines()) {
			if (line === EXIT_COMMAND) {
				break;
			}

			const reply = await session.dialog.send(line);
			console.log(reply);

			if (process.stdin.isTTY) {
				console.log(); // blank line between turns for readability
			}
		}
	} finally {
		session.dispose();
	}
}
