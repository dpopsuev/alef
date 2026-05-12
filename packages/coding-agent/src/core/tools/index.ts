export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	createPlatformShellAdapter,
	PosixShellAdapter,
	type ShellAdapter,
	type ShellAdapterContext,
	WindowsShellAdapter,
} from "./shell-adapter.js";
export {
	createSupervisorToolDefinition,
	type SupervisorToolDetails,
	type SupervisorToolInput,
	SupervisorToolInputSchema,
} from "./supervisor.js";
export {
	createSymbolOutlineTool,
	createSymbolOutlineToolDefinition,
	type SymbolOutlineOperations,
	type SymbolOutlineToolDetails,
	type SymbolOutlineToolInput,
	type SymbolOutlineToolOptions,
} from "./symbol-outline.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "@dpopsuev/alef-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { decorateBuiltInToolDefinition } from "../platform/organs.js";
import { type BashToolOptions, createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createSymbolOutlineToolDefinition, type SymbolOutlineToolOptions } from "./symbol-outline.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

/** Built-in tools: `file_*` (filesystem/shell) and `symbol_*` (structure / future LSP & tree-sitter). */
export type ToolName =
	| "symbol_outline"
	| "file_read"
	| "file_bash"
	| "file_edit"
	| "file_write"
	| "file_grep"
	| "file_find"
	| "file_ls";

export const allToolNames: Set<ToolName> = new Set([
	"symbol_outline",
	"file_read",
	"file_bash",
	"file_edit",
	"file_write",
	"file_grep",
	"file_find",
	"file_ls",
]);

export interface ToolsOptions {
	symbolOutline?: SymbolOutlineToolOptions;
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

function createRawToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "symbol_outline":
			return createSymbolOutlineToolDefinition(cwd, options?.symbolOutline);
		case "file_read":
			return createReadToolDefinition(cwd, options?.read);
		case "file_bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "file_edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "file_write":
			return createWriteToolDefinition(cwd, options?.write);
		case "file_grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "file_find":
			return createFindToolDefinition(cwd, options?.find);
		case "file_ls":
			return createLsToolDefinition(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	return decorateBuiltInToolDefinition(toolName, createRawToolDefinition(toolName, cwd, options));
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createToolDefinition("symbol_outline", cwd, options),
		createToolDefinition("file_read", cwd, options),
		createToolDefinition("file_bash", cwd, options),
		createToolDefinition("file_edit", cwd, options),
		createToolDefinition("file_write", cwd, options),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createToolDefinition("symbol_outline", cwd, options),
		createToolDefinition("file_read", cwd, options),
		createToolDefinition("file_grep", cwd, options),
		createToolDefinition("file_find", cwd, options),
		createToolDefinition("file_ls", cwd, options),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		symbol_outline: createToolDefinition("symbol_outline", cwd, options),
		file_read: createToolDefinition("file_read", cwd, options),
		file_bash: createToolDefinition("file_bash", cwd, options),
		file_edit: createToolDefinition("file_edit", cwd, options),
		file_write: createToolDefinition("file_write", cwd, options),
		file_grep: createToolDefinition("file_grep", cwd, options),
		file_find: createToolDefinition("file_find", cwd, options),
		file_ls: createToolDefinition("file_ls", cwd, options),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createTool("symbol_outline", cwd, options),
		createTool("file_read", cwd, options),
		createTool("file_bash", cwd, options),
		createTool("file_edit", cwd, options),
		createTool("file_write", cwd, options),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createTool("symbol_outline", cwd, options),
		createTool("file_read", cwd, options),
		createTool("file_grep", cwd, options),
		createTool("file_find", cwd, options),
		createTool("file_ls", cwd, options),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		symbol_outline: createTool("symbol_outline", cwd, options),
		file_read: createTool("file_read", cwd, options),
		file_bash: createTool("file_bash", cwd, options),
		file_edit: createTool("file_edit", cwd, options),
		file_write: createTool("file_write", cwd, options),
		file_grep: createTool("file_grep", cwd, options),
		file_find: createTool("file_find", cwd, options),
		file_ls: createTool("file_ls", cwd, options),
	};
}
