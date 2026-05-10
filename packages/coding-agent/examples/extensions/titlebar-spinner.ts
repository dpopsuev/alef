/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   alf --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@alf-agent/coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(alf: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = alf.getSessionName();
	return session ? `Alf - ${session} - ${cwd}` : `Alf - ${cwd}`;
}

export default function (alf: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(alf));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = alf.getSessionName();
			const title = session ? `${frame} Alf - ${session} - ${cwd}` : `${frame} Alf - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	alf.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	alf.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	alf.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
