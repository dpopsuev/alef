/**
 * Async generator that yields lines from stdin.
 *
 * Handles both interactive (TTY) and piped input.
 * In interactive mode, prints a prompt prefix so the user
 * knows the agent is ready for input.
 */

import { createInterface } from "node:readline";

const PROMPT_PREFIX = "> ";

export async function* readStdinLines(): AsyncGenerator<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdin.isTTY ? process.stdout : undefined,
		terminal: process.stdin.isTTY,
		prompt: PROMPT_PREFIX,
	});

	if (process.stdin.isTTY) {
		rl.prompt();
	}

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed) {
			yield trimmed;
		}
		if (process.stdin.isTTY) {
			rl.prompt();
		}
	}
}
