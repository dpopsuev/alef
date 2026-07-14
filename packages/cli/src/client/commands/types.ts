/**
 * Shared TUI command types and registry.
 */

import type { AdapterManagementSession, Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ChatLog } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../../boot/interactive.js";
import type { TuiEvent } from "../events.js";
import type { ThemeTokens } from "../theme.js";

/** Shared context passed to every TUI command handler. */
export interface TuiHandlerContext {
	t: ThemeTokens;
	writer: ChatLog;
	opts?: InteractiveOptions;
	tui: {
		stop(): void;
		requestRender(force?: boolean): void;
	};
	session: Session;
	store?: SessionStore;
	dispatch: (event: TuiEvent) => void;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
	/** Live session token counters from TUI state (snapshot per command). */
	sessionTokens?: {
		input: number;
		output: number;
		total: number;
		costUsd: number;
		contextFill: number;
		contextWindow: number;
	};
}

/** Lifecycle commands: quit, detach, clear, session, help. */
export type LifecycleCmdCtx = Pick<TuiHandlerContext, "session" | "writer" | "tui">;

/** Auth commands: login, logout. */
export type AuthCmdCtx = Pick<TuiHandlerContext, "writer" | "tui">;

/** Adapter load/unload/reload/package commands. */
export type AdapterCmdCtx = Pick<TuiHandlerContext, "t" | "writer" | "tui" | "dispatch"> & {
	session: Partial<AdapterManagementSession>;
};

/** Meta-agent and directive commands. */
export type MetaCmdCtx = Pick<TuiHandlerContext, "t" | "writer" | "tui" | "dispatch" | "session">;

/** Theme/model/think/profile/skills commands. */
export type SettingsCmdCtx = Pick<TuiHandlerContext, "t" | "writer" | "tui" | "dispatch" | "session" | "opts">;

/** Sticky note commands. */
export type NotesCmdCtx = Pick<TuiHandlerContext, "writer" | "tui" | "store" | "opts">;

/** A named, dispatchable TUI command with a description and run handler. */
export interface Command {
	name: string;
	description: string;
	run(ctx: TuiHandlerContext, args: string[]): void | Promise<void>;
}

/** Registry of TUI commands keyed by name and optional aliases. */
export class CommandRegistry {
	private readonly _commands = new Map<string, Command>();

	register(cmd: Command, ...aliases: string[]): this {
		this._commands.set(cmd.name, cmd);
		for (const alias of aliases) this._commands.set(alias, cmd);
		return this;
	}

	find(name: string): Command | undefined {
		return this._commands.get(name);
	}

	list(): ReadonlyArray<Command> {
		return [...new Set(this._commands.values())];
	}
}

/** Run async command work and surface failures as notice lines. */
export function attempt(ctx: Pick<TuiHandlerContext, "writer" | "tui">, work: () => Promise<void>): void {
	work().catch((e: unknown) => {
		ctx.writer.addNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
		ctx.tui.requestRender();
	});
}
