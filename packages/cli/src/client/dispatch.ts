import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { registry } from "./commands/commands.js";
import type { TuiHandlerContext } from "./commands/types.js";

export type { TuiHandlerContext } from "./commands/types.js";

export function renderHeaderTopBorder(label: string, _width: number): string {
	return label;
}

export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		traceEvent("ctrl+c:mid-turn");
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.session.setTurnController(undefined);
		ctx.writer.addNotice("(interrupted)");
		ctx.tui.requestRender(true);
	} else {
		traceEvent("ctrl+c:idle:dispose");
		ctx.session.dispose();
		traceEvent("ctrl+c:idle:tui.stop");
		ctx.tui.stop();
	}
}

/**
 * Slash commands are aliases into the command registry.
 * /exit → :quit, /new → :clear, /resume → :session, /login → :login, etc.
 * The registry is the single source of truth — slash is just a UI convention.
 */
const SLASH_TO_COLON: Record<string, string> = {
	"/exit": "quit",
	"/new": "clear",
	"/resume": "session",
	"/login": "login",
	"/logout": "logout",
	"/help": "help",
};

export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const parts = text.trim().split(/\s+/);
	const slash = parts[0].toLowerCase();
	const colonName = SLASH_TO_COLON[slash];
	if (!colonName) {
		ctx.writer.addNotice(`Unknown command: ${slash}. Type /help for list.`);
		ctx.tui.requestRender();
		return false;
	}
	const cmd = registry.find(colonName);
	if (!cmd) {
		ctx.writer.addNotice(`Command '${colonName}' not registered.`);
		ctx.tui.requestRender();
		return false;
	}
	void cmd.run(ctx, parts.slice(1));
	return true;
}

export function handleColonCommand(text: string, ctx: TuiHandlerContext): boolean {
	const parts = text.trim().split(/\s+/);
	const name = (parts[0] ?? "").replace(/^:/, "").toLowerCase();
	const cmd = registry.find(name);
	if (!cmd) {
		ctx.writer.addNotice("Unknown command. Type :help for list.");
		ctx.tui.requestRender();
		return false;
	}
	void cmd.run(ctx, parts.slice(1));
	return true;
}
