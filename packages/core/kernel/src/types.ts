/**
 * Core type re-exports for backward compatibility and gate validation.
 * Primary type definitions live in their respective modules.
 */

export type {
	FilesystemPermission,
	FilesystemOperation,
	PermissionMode,
	PermissionSchema,
} from "./adapter/permissions.js";

export type {
	Adapter,
	AdapterContributions,
	AdapterOptions,
	CommandAction,
	EventAction,
	ActionMap,
	CommandHandlerCtx,
	EventHandlerCtx,
	ToolDefinition,
} from "./adapter/index.js";
