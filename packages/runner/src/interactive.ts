/**
 * Interactive mode — read lines from stdin, send each to the agent, print replies.
 *
 * The caller owns agent lifecycle. This function only drives the dialog loop.
 *
 * Type /exit or press Ctrl+D to quit.
 * Conversation history accumulates across turns (DialogOrgan.history).
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { readStdinLines } from "./stdin.js";

const EXIT_COMMAND = "/exit";

export interface InteractiveOptions {
	cwd: string;
	modelId: string;
}

export async function runInteractive(
	dialog: DialogOrgan,
	opts: InteractiveOptions,
	dispose: () => void,
): Promise<void> {
	if (process.stdin.isTTY) {
		console.log(`Alef agent ready. Working directory: ${opts.cwd}`);
		console.log(`Model: ${opts.modelId}`);
		console.log(`Type ${EXIT_COMMAND} or Ctrl+D to quit.\n`);
	}

	try {
		for await (const line of readStdinLines()) {
			if (line === EXIT_COMMAND) {
				break;
			}

			await dialog.send(line);

			if (process.stdin.isTTY) {
				console.log(); // blank line between turns for readability
			}
		}
	} finally {
		dispose();
	}
}
