/**
 * Command registry — all TUI commands as named, dispatchable units.
 *
 * Domain modules: lifecycle, auth, adapters, meta, settings, notes.
 * The colon prefix is the TUI invoker convention, not part of the command.
 */

import { install, load, reload, rollback, unload, upgrade } from "./adapter-cmds.js";
import { login, logout } from "./auth-cmds.js";
import {
	clear,
	compact,
	context,
	createHelpCommand,
	detach,
	exit,
	restart,
	session,
	status,
	tokens,
	update,
} from "./lifecycle-cmds.js";
import { directive, meta } from "./meta-cmds.js";
import { stickies, sticky } from "./notes-cmds.js";
import { plan } from "./plan-cmds.js";
import { rename, tag } from "./session-meta-cmds.js";
import { model, profile, skills, theme, think } from "./settings-cmds.js";
import { tasks } from "./task-cmds.js";
import { CommandRegistry } from "./types.js";

export {
	buildPickerTheme,
	type ConfigPickerOptions,
	type EnumPickerOptions,
	openConfigPicker,
	openEnumPicker,
	openPicker,
	type PickerOptions,
} from "./overlay-picker.js";
export type {
	AdapterCmdCtx,
	AuthCmdCtx,
	Command,
	LifecycleCmdCtx,
	MetaCmdCtx,
	NotesCmdCtx,
	SettingsCmdCtx,
	TuiHandlerContext,
} from "./types.js";
export { attempt, CommandRegistry } from "./types.js";

/** Single source of truth for all TUI commands — tab-completion and help derive from this. */
export const registry = new CommandRegistry();

const help = createHelpCommand(() => registry.list());

registry
	.register(exit, "quit", "exit")
	.register(restart)
	.register(update)
	.register(tokens)
	.register(status)
	.register(detach)
	.register(clear, "clear")
	.register(compact)
	.register(session)
	.register(context)
	.register(rename)
	.register(tag)
	.register(plan)
	.register(help, "h")
	.register(login)
	.register(logout)
	.register(reload)
	.register(load)
	.register(unload)
	.register(install)
	.register(upgrade)
	.register(rollback)
	.register(meta)
	.register(directive)
	.register(theme)
	.register(model)
	.register(think)
	.register(profile)
	.register(skills)
	.register(tasks, "jobs")
	.register(sticky, "note", "pin")
	.register(stickies);
