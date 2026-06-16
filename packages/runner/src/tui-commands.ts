import { getProviders } from "@dpopsuev/alef-llm";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "./auth.js";
import { registry } from "./commands/index.js";
import type { TuiHandlerContext } from "./commands/types.js";
import { trace } from "./debug-trace.js";

export type { TuiHandlerContext } from "./commands/types.js";

export function renderHeaderTopBorder(label: string, _width: number): string {
	return label;
}

export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		trace("ctrl+c:mid-turn");
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.session.setTurnController(undefined);
		ctx.writer.addNotice("(interrupted)");
		ctx.tui.requestRender(true);
	} else {
		trace("ctrl+c:idle:dispose");
		ctx.session.dispose();
		trace("ctrl+c:idle:tui.stop");
		ctx.tui.stop();
	}
}

const SLASH_COMMANDS: Record<string, string> = {
	"/exit": "Quit (alias: :q)",
	"/new": "Clear conversation (alias: :new)",
	"/resume": "Show session ID (alias: :session)",
	"/login": "Save API key: /login <provider> <key>",
	"/logout": "Remove stored API key: /logout <provider>",
	"/help": "Show this help",
};

function helpText(): string {
	const slashLines = Object.entries(SLASH_COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
	const colonLines = registry
		.list()
		.map((c) => `  :${c.name.padEnd(11)} ${c.description}`)
		.join("\n");
	return `Normal-mode commands (press ':' then type):\n${colonLines}\n\nInsert-mode slash aliases:\n${slashLines}`;
}

export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const cmd = text.split(" ")[0].toLowerCase();
	switch (cmd) {
		case "/exit":
			ctx.session.dispose();
			ctx.tui.stop();
			return true;
		case "/new":
			ctx.writer.clearAll();
			ctx.writer.addNotice("(conversation cleared)");
			ctx.tui.requestRender(true);
			return true;
		case "/resume":
			ctx.writer.addNotice(`session: ${ctx.session.state.id}`);
			ctx.tui.requestRender();
			return true;
		case "/login": {
			const parts = text.trim().split(/\s+/);
			const provider = parts[1];
			const key = parts.slice(2).join(" ").trim();
			if (!provider || !key) {
				ctx.writer.addNotice(
					`Usage: /login <provider> <api-key>\nKnown providers: ${getProviders().slice(0, 8).join(", ")}`,
				);
			} else {
				setStoredApiKey(provider, key);
				ctx.writer.addNotice(`Saved API key for ${provider}. Takes effect on the next message.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/logout": {
			const provider = text.trim().split(/\s+/)[1];
			if (!provider) {
				ctx.writer.addNotice("Usage: /logout <provider>");
			} else if (!getStoredApiKey(provider)) {
				ctx.writer.addNotice(`No stored key for ${provider}.`);
			} else {
				removeStoredApiKey(provider);
				ctx.writer.addNotice(`Removed stored key for ${provider}.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/help":
			ctx.writer.addNotice(helpText());
			ctx.tui.requestRender();
			return true;
		default:
			ctx.writer.addNotice(`Unknown command: ${cmd}. Type /help for list.`);
			ctx.tui.requestRender();
			return false;
	}
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
