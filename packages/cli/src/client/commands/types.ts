/**
 * Shared TUI command types and registry.
 */

import type { AdapterManagementSession, Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { Editor } from "@dpopsuev/alef-tui";
import type { ChatLog } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions, RebootPort, RestartStrategy } from "../boot-types.js";
import type { TuiEvent } from "../events.js";
import type { TaskLedgerEntry } from "../state.js";
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
	taskLedger?: readonly TaskLedgerEntry[];
	editor?: Editor;
	rebootPort?: RebootPort;
	restartStrategy?: RestartStrategy;
}

/** Lifecycle commands: quit, detach, clear, session, help. */
export type LifecycleCmdCtx = Pick<TuiHandlerContext, "session" | "writer" | "tui" | "rebootPort" | "restartStrategy">;

/** Auth commands: login, logout. */
export type AuthCmdCtx = Pick<TuiHandlerContext, "writer" | "tui">;

/** Adapter load/unload/reload/package commands. */
export type AdapterCmdCtx = Pick<TuiHandlerContext, "t" | "writer" | "tui" | "dispatch"> & {
	session: Partial<AdapterManagementSession>;
};

/** Meta-agent and directive commands. */
export type MetaCmdCtx = Pick<TuiHandlerContext, "t" | "writer" | "tui" | "dispatch" | "session">;

/** Theme/model/think/profile/skills commands. */
export type SettingsCmdCtx = Pick<
	TuiHandlerContext,
	"t" | "writer" | "tui" | "dispatch" | "session" | "opts" | "editor"
>;

/** Dock note commands. */
export type NotesCmdCtx = Pick<TuiHandlerContext, "writer" | "tui" | "store" | "opts">;

/** One argument / subcommand row for `:command ` autocomplete. */
export interface CommandArgument {
	value: string;
	description: string;
}

/** Item shape accepted by CombinedAutocompleteProvider argument completions. */
export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

/** A named, dispatchable TUI command with a description and run handler. */
export interface Command {
	name: string;
	description: string;
	/** Dimmed hint beside the command name while typing `:name` (before space). */
	argumentHint?: string;
	/** Static verb/arg rows after `:name `. */
	arguments?: ReadonlyArray<CommandArgument>;
	/** Dynamic argument completions; wins over `arguments` when set. */
	getArgumentCompletions?(
		argumentPrefix: string,
	): CommandArgumentCompletion[] | null | Promise<CommandArgumentCompletion[] | null>;
	run(ctx: TuiHandlerContext, args: string[]): void | Promise<void>;
}

/** One completable name for a registered command (canonical or alias). */
export interface CommandCompletion {
	name: string;
	description: string;
	/** True when this completion is an alias of Command.name. */
	alias: boolean;
	argumentHint?: string;
}

/** Filter static command arguments for the first token after `:name `. */
export function completeCommandArguments(
	args: ReadonlyArray<CommandArgument>,
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	if (argumentPrefix.includes(" ")) return null;
	const token = argumentPrefix.toLowerCase();
	const filtered = args.filter((arg) => arg.value.toLowerCase().startsWith(token));
	if (filtered.length === 0) return null;
	return filtered.map((arg) => ({
		value: arg.value,
		label: arg.value,
		description: arg.description,
	}));
}

/** Registry of TUI commands keyed by name and optional aliases. */
export class CommandRegistry {
	private readonly _commands = new Map<string, Command>();
	private readonly _aliases = new Map<string, readonly string[]>();

	register(cmd: Command, ...aliases: string[]): this {
		this._commands.set(cmd.name, cmd);
		const unique = [...new Set(aliases.filter((alias) => alias && alias !== cmd.name))];
		this._aliases.set(cmd.name, unique);
		for (const alias of unique) this._commands.set(alias, cmd);
		return this;
	}

	find(name: string): Command | undefined {
		return this._commands.get(name);
	}

	/** Unique commands (canonical names only). */
	list(): ReadonlyArray<Command> {
		return [...new Set(this._commands.values())];
	}

	/** Canonical name plus every alias — for :autocomplete and which-key. */
	listCompletions(): ReadonlyArray<CommandCompletion> {
		const out: CommandCompletion[] = [];
		for (const cmd of this.list()) {
			out.push({
				name: cmd.name,
				description: cmd.description,
				alias: false,
				...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
			});
			for (const alias of this._aliases.get(cmd.name) ?? []) {
				out.push({
					name: alias,
					description: cmd.description,
					alias: true,
					...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
				});
			}
		}
		return out;
	}

	/** SlashCommand rows for the editor autocomplete provider. */
	toSlashCommands(): Array<{
		name: string;
		description: string;
		argumentHint?: string;
		getArgumentCompletions?: (
			argumentPrefix: string,
		) => CommandArgumentCompletion[] | null | Promise<CommandArgumentCompletion[] | null>;
	}> {
		return this.listCompletions().map((completion) => {
			const cmd = this.find(completion.name)!;
			const getArgumentCompletions =
				cmd.getArgumentCompletions ??
				(cmd.arguments ? (prefix: string) => completeCommandArguments(cmd.arguments!, prefix) : undefined);
			return {
				name: completion.name,
				description: completion.description,
				...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
				...(getArgumentCompletions ? { getArgumentCompletions } : {}),
			};
		});
	}

	aliasesOf(name: string): readonly string[] {
		const cmd = this.find(name);
		if (!cmd) return [];
		return this._aliases.get(cmd.name) ?? [];
	}
}

/** Run async command work and surface failures as notice lines. */
export function attempt(ctx: Pick<TuiHandlerContext, "writer" | "tui">, work: () => Promise<void>): void {
	work().catch((e: unknown) => {
		ctx.writer.addNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
		ctx.tui.requestRender();
	});
}
