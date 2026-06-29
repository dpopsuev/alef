import type { TuiHandlerContext } from "./types.js";

export interface Command {
	/** Name as typed by the user, without the invoker prefix (e.g. "reload", not ":reload"). */
	name: string;
	description: string;
	run(ctx: TuiHandlerContext, args: string[]): void | Promise<void>;
}

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

	/** Returns each unique command once, ordered by first registration. */
	list(): ReadonlyArray<Command> {
		return [...new Set(this._commands.values())];
	}
}
