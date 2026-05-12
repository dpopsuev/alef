import { type BoardPath, parseBoardAddress } from "@dpopsuev/alef-agent-runtime/board";
import { APP_NAME } from "../config.js";

export interface BuiltinOperatorCommand {
	name: string;
	description: string;
	aliases?: readonly string[];
}

export const BUILTIN_OPERATOR_COMMANDS: ReadonlyArray<BuiltinOperatorCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "review", description: "Open the discourse-backed review board" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "bootstrap", description: "Run the first-run bootstrap flow", aliases: ["coolstart"] },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

const BUILTIN_OPERATOR_COMMAND_NAMES = new Set(
	BUILTIN_OPERATOR_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
);

export interface PrefixedCommand {
	prefix: ":" | "/";
	name: string;
	args: string;
}

export interface ParsedTextInput {
	kind: "text";
	raw: string;
}

export interface ParsedOperatorCommand extends PrefixedCommand {
	kind: "operator_command";
	raw: string;
}

export interface ParsedLegacySlashCommand extends PrefixedCommand {
	kind: "legacy_slash_command";
	raw: string;
}

export interface ParsedShellCommand {
	kind: "shell";
	raw: string;
	command: string;
	excludeFromContext: boolean;
}

export interface ParsedEntityReference {
	kind: "entity_reference";
	raw: string;
	entity: string;
	remainder: string;
}

export interface ParsedAddressReference {
	kind: "address_reference";
	raw: string;
	address: BoardPath;
	remainder: string;
}

export interface ParsedPathLiteral {
	kind: "path_literal";
	raw: string;
	path: string;
	remainder: string;
}

export interface ParsedBindingReference {
	kind: "binding_reference";
	raw: string;
	name: string;
	remainder: string;
}

export interface ParsedQueryReference {
	kind: "query_reference";
	raw: string;
	query: string;
}

export type ParsedSymbolicInput =
	| ParsedAddressReference
	| ParsedBindingReference
	| ParsedEntityReference
	| ParsedLegacySlashCommand
	| ParsedOperatorCommand
	| ParsedPathLiteral
	| ParsedQueryReference
	| ParsedShellCommand
	| ParsedTextInput;

export interface ParseSymbolicInputOptions {
	legacyCommandNames?: Iterable<string>;
}

function splitTokenAndRemainder(raw: string): { token: string; remainder: string } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { token: "", remainder: "" };
	}

	const whitespaceIndex = trimmed.search(/\s/);
	if (whitespaceIndex === -1) {
		return { token: trimmed, remainder: "" };
	}

	return {
		token: trimmed.slice(0, whitespaceIndex),
		remainder: trimmed.slice(whitespaceIndex).trim(),
	};
}

export function parsePrefixedCommand(text: string, prefix: ":" | "/"): PrefixedCommand | undefined {
	if (!text.startsWith(prefix)) {
		return undefined;
	}

	const { token, remainder } = splitTokenAndRemainder(text.slice(prefix.length));
	if (token.length === 0) {
		return undefined;
	}

	return {
		prefix,
		name: token,
		args: remainder,
	};
}

export function isBuiltinOperatorCommand(name: string): boolean {
	return BUILTIN_OPERATOR_COMMAND_NAMES.has(name.trim());
}

function isLegacySlashCommand(text: string, options?: ParseSymbolicInputOptions): PrefixedCommand | undefined {
	const parsed = parsePrefixedCommand(text, "/");
	if (!parsed) {
		return undefined;
	}

	const legacyNames = new Set(options?.legacyCommandNames ?? BUILTIN_OPERATOR_COMMAND_NAMES);
	return legacyNames.has(parsed.name) ? parsed : undefined;
}

export function parseSymbolicInput(text: string, options?: ParseSymbolicInputOptions): ParsedSymbolicInput {
	const raw = text.trim();
	if (raw.length === 0) {
		return { kind: "text", raw };
	}

	if (raw.startsWith("!!")) {
		return {
			kind: "shell",
			raw,
			command: raw.slice(2).trim(),
			excludeFromContext: true,
		};
	}

	if (raw.startsWith("!")) {
		return {
			kind: "shell",
			raw,
			command: raw.slice(1).trim(),
			excludeFromContext: false,
		};
	}

	const operatorCommand = parsePrefixedCommand(raw, ":");
	if (operatorCommand) {
		return {
			kind: "operator_command",
			raw,
			...operatorCommand,
		};
	}

	const legacySlashCommand = isLegacySlashCommand(raw, options);
	if (legacySlashCommand) {
		return {
			kind: "legacy_slash_command",
			raw,
			...legacySlashCommand,
		};
	}

	if (raw.startsWith("#")) {
		const { token, remainder } = splitTokenAndRemainder(raw.slice(1));
		if (token.length === 0) {
			return { kind: "text", raw };
		}
		return {
			kind: "address_reference",
			raw,
			address: parseBoardAddress(token),
			remainder,
		};
	}

	if (raw.startsWith("@")) {
		const { token, remainder } = splitTokenAndRemainder(raw.slice(1));
		if (token.length === 0) {
			return { kind: "text", raw };
		}
		return {
			kind: "entity_reference",
			raw,
			entity: token,
			remainder,
		};
	}

	if (raw.startsWith("$")) {
		const { token, remainder } = splitTokenAndRemainder(raw.slice(1));
		if (token.length === 0) {
			return { kind: "text", raw };
		}
		return {
			kind: "binding_reference",
			raw,
			name: token,
			remainder,
		};
	}

	if (raw.startsWith("?")) {
		return {
			kind: "query_reference",
			raw,
			query: raw.slice(1).trim(),
		};
	}

	if (raw.startsWith("/")) {
		const { token, remainder } = splitTokenAndRemainder(raw);
		return {
			kind: "path_literal",
			raw,
			path: token,
			remainder,
		};
	}

	return { kind: "text", raw };
}
