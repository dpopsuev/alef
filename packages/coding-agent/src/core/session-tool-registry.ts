/**
 * SessionToolRegistry — owns the active tool surface for one AgentSession.
 *
 * Previously these five Maps and _refreshToolRegistry() lived directly in
 * AgentSession. Extracting them here separates tool lifecycle management
 * from prompt orchestration.
 *
 * Responsibilities:
 *   - Track which tool definitions are available (base + extension + custom)
 *   - Track which tools are active (subset of available, honoring allowlist)
 *   - Maintain prompt snippets and guidelines per tool (injected into system prompt)
 *   - Maintain the action registry (platform action metadata)
 *   - Refresh the above when tools change (extension registration, reload)
 */

import type { AgentTool } from "@dpopsuev/alef-agent-core";
import { wrapRegisteredTools } from "./extensions/index.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ToolDefinition, ToolInfo } from "./extensions/types.js";
import { createPlatformActionInfoFromToolDefinition, PlatformActionRegistry } from "./platform/index.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

// ---------------------------------------------------------------------------
// SessionToolRegistry
// ---------------------------------------------------------------------------

export interface SessionToolRegistryOptions {
	customTools: ToolDefinition[];
	allowedToolNames?: Set<string>;
}

export class SessionToolRegistry {
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _actionRegistry = new PlatformActionRegistry();
	private _activeToolNames: string[] = [];

	private readonly _customTools: ToolDefinition[];
	private readonly _allowedToolNames?: Set<string>;

	constructor(options: SessionToolRegistryOptions) {
		this._customTools = options.customTools;
		this._allowedToolNames = options.allowedToolNames;
	}

	// -------------------------------------------------------------------------
	// Base tool definitions (set once by _buildRuntime / organ bus)
	// -------------------------------------------------------------------------

	setBaseToolDefinitions(defs: Map<string, ToolDefinition>): void {
		this._baseToolDefinitions = defs;
	}

	// -------------------------------------------------------------------------
	// Refresh — called after base tools change or extensions register new tools
	// -------------------------------------------------------------------------

	refresh(
		runner: ExtensionRunner,
		options?: {
			activeToolNames?: string[];
			includeAllExtensionTools?: boolean;
		},
	): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);

		const registeredTools = runner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));

		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}

		this._toolDefinitions = definitionRegistry;

		this._actionRegistry = new PlatformActionRegistry();
		this._actionRegistry.registerMany(
			Array.from(definitionRegistry.values()).map(({ definition, sourceInfo }) =>
				createPlatformActionInfoFromToolDefinition(definition, sourceInfo),
			),
		);

		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = normalizeSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);

		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = normalizeGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);

		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this._activeToolNames = [...new Set(nextActiveToolNames)];
	}

	// -------------------------------------------------------------------------
	// Active tool management
	// -------------------------------------------------------------------------

	/** Resolve names to AgentTool[] honouring the current registry. Returns valid tools and their names. */
	resolveActive(toolNames: string[]): { tools: AgentTool[]; validNames: string[] } {
		const tools: AgentTool[] = [];
		const validNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validNames.push(name);
			}
		}
		return { tools, validNames };
	}

	setActiveNames(names: string[]): void {
		this._activeToolNames = [...new Set(names)];
	}

	getActiveToolNames(): string[] {
		return this._activeToolNames.filter((name) => this._toolRegistry.has(name));
	}

	// -------------------------------------------------------------------------
	// Read-only queries
	// -------------------------------------------------------------------------

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	getToolRegistry(): Map<string, AgentTool> {
		return this._toolRegistry;
	}

	getPromptSnippets(): Map<string, string> {
		return this._toolPromptSnippets;
	}

	getPromptGuidelines(): Map<string, string[]> {
		return this._toolPromptGuidelines;
	}

	getActionRegistry(): InstanceType<typeof PlatformActionRegistry> {
		return this._actionRegistry;
	}

	hasBaseTool(name: string): boolean {
		return this._baseToolDefinitions.has(name);
	}
}

// ---------------------------------------------------------------------------
// Pure helpers (moved from AgentSession._normalizePromptSnippet/Guidelines)
// ---------------------------------------------------------------------------

function normalizeSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

function normalizeGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) return [];
	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) unique.add(normalized);
	}
	return Array.from(unique);
}
