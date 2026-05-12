import type { AgentCapabilityDefinition, AgentTool } from "@dpopsuev/alef-agent-core";
import type { ToolDefinition } from "../../../coding-agent/src/core/extensions/types.js";
import type { PlatformActionInfo } from "../../../coding-agent/src/core/platform/types.js";
import type { SourceInfo } from "../../../coding-agent/src/core/source-info.js";

function normalizeActionInfo(options: {
	name: string;
	label: string;
	description: string;
	parameters?: unknown;
	executionMode?: AgentTool["executionMode"];
	action?: AgentTool["action"];
	sourceInfo?: SourceInfo;
}): PlatformActionInfo {
	return {
		name: options.name,
		label: options.label,
		description: options.description,
		parameters: options.parameters,
		executionMode: options.executionMode,
		sourceInfo: options.sourceInfo,
		action: options.action ?? {
			kind: "tool",
			capability: options.name,
			availability: "shared",
		},
	};
}

export function createPlatformActionInfoFromToolDefinition(
	definition: ToolDefinition,
	sourceInfo?: SourceInfo,
): PlatformActionInfo {
	return normalizeActionInfo({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		executionMode: definition.executionMode,
		action: definition.action,
		sourceInfo,
	});
}

export function createPlatformActionInfoFromAgentTool(tool: AgentTool, sourceInfo?: SourceInfo): PlatformActionInfo {
	return normalizeActionInfo({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		executionMode: tool.executionMode,
		action: tool.action,
		sourceInfo,
	});
}

export class PlatformActionRegistry {
	private readonly actions = new Map<string, PlatformActionInfo>();

	register(action: PlatformActionInfo): void {
		this.actions.set(action.name, action);
	}

	registerMany(actions: PlatformActionInfo[]): void {
		for (const action of actions) {
			this.register(action);
		}
	}

	getAction(name: string): PlatformActionInfo | undefined {
		return this.actions.get(name);
	}

	getActions(): PlatformActionInfo[] {
		return Array.from(this.actions.values());
	}

	getCapabilities(): AgentCapabilityDefinition[] {
		const capabilities = new Map<string, AgentCapabilityDefinition>();

		for (const action of this.actions.values()) {
			const capabilityName = action.action.capability ?? action.name;
			const existing = capabilities.get(capabilityName);
			if (existing) {
				existing.actions.push({
					name: action.name,
					label: action.label,
					description: action.description,
					parameters: action.parameters as AgentTool["parameters"],
					action: action.action,
					executionMode: action.executionMode,
					execute: async () => {
						throw new Error(`Action ${action.name} is metadata-only in this registry view.`);
					},
				});
				continue;
			}

			capabilities.set(capabilityName, {
				name: capabilityName,
				kind: action.action.kind,
				description: action.action.description,
				availability: action.action.availability,
				actions: [
					{
						name: action.name,
						label: action.label,
						description: action.description,
						parameters: action.parameters as AgentTool["parameters"],
						action: action.action,
						executionMode: action.executionMode,
						execute: async () => {
							throw new Error(`Action ${action.name} is metadata-only in this registry view.`);
						},
					},
				],
			});
		}

		return Array.from(capabilities.values());
	}
}
