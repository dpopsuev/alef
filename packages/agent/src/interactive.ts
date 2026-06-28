/**
 * Interactive mode — read lines from stdin, send each to the agent, print replies.
 *
 * The caller owns agent lifecycle. This function only drives the dialog loop.
 *
 * Type /exit or press Ctrl+D to quit.
 * Conversation history accumulates across turns.
 */

import { formatError } from "@dpopsuev/alef-agent/errors";
import type { Session } from "@dpopsuev/alef-session/contracts";
import { readStdinLines } from "./stdin.js";

const EXIT_COMMAND = "/exit";

import type { ActorRouteTable } from "@dpopsuev/alef-agent/identity/routes";

export interface InteractiveOptions {
	cwd: string;
	modelId: string;
	sessionId: string;
	contextWindow?: number;
	getModel?: () => string;
	setModel?: (id: string) => void;
	getThinking?: () => string;
	setThinking?: (level: string) => void;
	/** Human's @ address for pill label. Default: "@you". */
	humanAddress?: string;
	/** Agent's @ address for pill label and @-routing. Default: "@alef". */
	agentAddress?: string;
	/** Route table for @-mention routing. */
	actorRoutes?: ActorRouteTable;
}

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
				console.error(formatError(e));
			}
			if (process.stdin.isTTY) {
				console.log();
			}
		}
	} finally {
		session.dispose();
	}
}
