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
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import {
	createSymbolOutlineTool,
	createSymbolOutlineToolDefinition,
	type SymbolOutlineToolOptions,
} from "./symbol-outline.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

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

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
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

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "symbol_outline":
			return createSymbolOutlineTool(cwd, options?.symbolOutline);
		case "file_read":
			return createReadTool(cwd, options?.read);
		case "file_bash":
			return createBashTool(cwd, options?.bash);
		case "file_edit":
			return createEditTool(cwd, options?.edit);
		case "file_write":
			return createWriteTool(cwd, options?.write);
		case "file_grep":
			return createGrepTool(cwd, options?.grep);
		case "file_find":
			return createFindTool(cwd, options?.find);
		case "file_ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createSymbolOutlineToolDefinition(cwd, options?.symbolOutline),
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createSymbolOutlineToolDefinition(cwd, options?.symbolOutline),
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		symbol_outline: createSymbolOutlineToolDefinition(cwd, options?.symbolOutline),
		file_read: createReadToolDefinition(cwd, options?.read),
		file_bash: createBashToolDefinition(cwd, options?.bash),
		file_edit: createEditToolDefinition(cwd, options?.edit),
		file_write: createWriteToolDefinition(cwd, options?.write),
		file_grep: createGrepToolDefinition(cwd, options?.grep),
		file_find: createFindToolDefinition(cwd, options?.find),
		file_ls: createLsToolDefinition(cwd, options?.ls),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createSymbolOutlineTool(cwd, options?.symbolOutline),
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createSymbolOutlineTool(cwd, options?.symbolOutline),
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		symbol_outline: createSymbolOutlineTool(cwd, options?.symbolOutline),
		file_read: createReadTool(cwd, options?.read),
		file_bash: createBashTool(cwd, options?.bash),
		file_edit: createEditTool(cwd, options?.edit),
		file_write: createWriteTool(cwd, options?.write),
		file_grep: createGrepTool(cwd, options?.grep),
		file_find: createFindTool(cwd, options?.find),
		file_ls: createLsTool(cwd, options?.ls),
	};
}
