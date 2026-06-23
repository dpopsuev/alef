import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import type { ColorToken } from "../cli/theme-types.js";
import { ALL_COLORS, hexToColorToken } from "./palette.js";

export interface ActorIdentity {
	type: "human" | "agent";
	/** The color or username — without the @ prefix. */
	color: string;
	/** The @ address: "@crimson" or "@dpopsuev". */
	address: string;
	/** ColorToken for TUI rendering. Neutral silver for humans. */
	token: ColorToken;
}

/** Stable index into the 144-color palette from a string seed. */
function stableColorIndex(seed: string): number {
	const digest = createHash("sha256").update(seed).digest();
	// Read 4 bytes as unsigned int, mod palette size.
	const n = digest.readUInt32BE(0);
	return n % ALL_COLORS.length;
}

/**
 * Resolve the human actor identity.
 * Identity = OS username — machine-global, stable, requires no config.
 */
export function resolveHumanActor(): ActorIdentity {
	const username = userInfo().username;
	const idx = stableColorIndex(`human:${username}`);
	const paletteColor = ALL_COLORS[idx];
	return {
		type: "human",
		color: username,
		address: `@${username}`,
		token: hexToColorToken(paletteColor.hex),
	};
}

/**
 * Resolve the agent actor identity.
 * Color is deterministically derived from sessionId — same session always
 * produces the same color name, no registry or file needed.
 */
export function resolveAgentActor(sessionId: string, _boardId: string): ActorIdentity {
	const idx = stableColorIndex(sessionId);
	const paletteColor = ALL_COLORS[idx];
	return {
		type: "agent",
		color: paletteColor.name,
		address: `@${paletteColor.name}`,
		token: hexToColorToken(paletteColor.hex),
	};
}

/** Resolve a subagent actor — different color from parent, same determinism. */
export function resolveSubagentActor(parentSessionId: string, toolCallId: string, boardId: string): ActorIdentity {
	return resolveAgentActor(`${parentSessionId}_${toolCallId}`, boardId);
}

/**
 * Configure session actors and theme in one call.
 * Resolves human and agent identities, creates a theme with their colors.
 * Returns all three for use in session setup.
 */
export function configureSessionActors(
	sessionId: string,
	boardId: string,
): {
	humanActor: ActorIdentity;
	agentActor: ActorIdentity;
	theme: { userFg: ColorToken; agentFg: ColorToken };
} {
	const humanActor = resolveHumanActor();
	const agentActor = resolveAgentActor(sessionId, boardId);
	const theme = { userFg: humanActor.token, agentFg: agentActor.token };
	return { humanActor, agentActor, theme };
}
