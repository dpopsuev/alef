/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   alef --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@dpopsuev/alef-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(alef: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = alef.getSessionName();
	return session ? `Alef - ${session} - ${cwd}` : `Alef - ${cwd}`;
}

export default function (alef: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(alef));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = alef.getSessionName();
			const title = session ? `${frame} Alef - ${session} - ${cwd}` : `${frame} Alef - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	alef.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	alef.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	alef.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
