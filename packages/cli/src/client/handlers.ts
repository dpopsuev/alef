import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { TuiHandlerContext } from "./commands/commands.js";
import { registry } from "./commands/commands.js";

export type { TuiHandlerContext } from "./commands/commands.js";

/** Render the top border of a chat header with an embedded label. */
export function renderHeaderTopBorder(label: string, _width: number): string {
	return label;
}

/** Handle Ctrl+C — abort the current turn if active, otherwise quit the TUI. */
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
		void ctx.session.dispose();
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

/** Dispatch a /slash command by mapping it to the corresponding colon command. */
export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const parts = text.trim().split(/\s+/);
	const slash = parts[0]!.toLowerCase();
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

/** Dispatch a :colon command by looking it up in the command registry. */
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
