import type { AgentActionMetadata } from "@dpopsuev/alef-agent-core";
import type {
	AgentDefinitionOrganInput,
	AgentOrganName,
	AgentRole,
	CompiledAgentDefinition,
	CompiledAgentOrganDefinition,
} from "./types.js";

type BuiltInToolName =
	| "symbol_outline"
	| "file_read"
	| "file_bash"
	| "file_edit"
	| "file_write"
	| "file_grep"
	| "file_find"
	| "file_ls"
	| "supervisor";

interface OrganActionSpec {
	toolNames: BuiltInToolName[];
}

interface OrganSpec {
	kind: AgentActionMetadata["kind"];
	availability: NonNullable<AgentActionMetadata["availability"]>;
	description: string;
	defaultActions: readonly string[];
	actions: Record<string, OrganActionSpec>;
}

const ORGAN_SPECS: Record<AgentOrganName, OrganSpec> = {
	fs: {
		kind: "tool",
		availability: "shared",
		description: "Filesystem organ for local project tree operations.",
		defaultActions: ["outline", "read", "write", "edit", "grep", "find", "ls"],
		actions: {
			outline: { toolNames: ["symbol_outline"] },
			read: { toolNames: ["file_read"] },
			write: { toolNames: ["file_write"] },
			edit: { toolNames: ["file_edit"] },
			grep: { toolNames: ["file_grep"] },
			find: { toolNames: ["file_find"] },
			ls: { toolNames: ["file_ls"] },
		},
	},
	shell: {
		kind: "tool",
		availability: "shared",
		description: "Shell organ for command execution.",
		defaultActions: ["exec"],
		actions: {
			exec: { toolNames: ["file_bash"] },
		},
	},
	supervisor: {
		kind: "supervisor",
		availability: "root",
		description: "Root-only supervisor organ for child-agent delegation.",
		defaultActions: [
			"createContract",
			"approveContract",
			"createTopic",
			"listTopics",
			"assignTopic",
			"readThread",
			"spawnAgent",
			"listAgents",
			"signalAgent",
			"killAgent",
			"sendAgentMessage",
		],
		actions: {
			createContract: { toolNames: ["supervisor"] },
			approveContract: { toolNames: ["supervisor"] },
			createTopic: { toolNames: ["supervisor"] },
			listTopics: { toolNames: ["supervisor"] },
			assignTopic: { toolNames: ["supervisor"] },
			readThread: { toolNames: ["supervisor"] },
			spawnAgent: { toolNames: ["supervisor"] },
			listAgents: { toolNames: ["supervisor"] },
			signalAgent: { toolNames: ["supervisor"] },
			killAgent: { toolNames: ["supervisor"] },
			sendAgentMessage: { toolNames: ["supervisor"] },
		},
	},
};

function normalizeOrganActions(actions: string[] | undefined, organName: AgentOrganName): string[] {
	const selectedActions = actions ?? [...ORGAN_SPECS[organName].defaultActions];
	const normalized = new Set<string>();
	for (const action of selectedActions) {
		const trimmed = action.trim();
		if (trimmed.length > 0) {
			normalized.add(trimmed);
		}
	}
	return Array.from(normalized);
}

export function getSupportedAgentOrganNames(): AgentOrganName[] {
	return Object.keys(ORGAN_SPECS) as AgentOrganName[];
}

export function getSupportedAgentOrganActions(name: AgentOrganName): string[] {
	return Object.keys(ORGAN_SPECS[name].actions);
}

export function compileAgentOrganDefinitions(
	inputs: AgentDefinitionOrganInput[] | undefined,
	role: AgentRole = "root",
): CompiledAgentOrganDefinition[] {
	if (!inputs || inputs.length === 0) {
		return [];
	}

	const compiled: CompiledAgentOrganDefinition[] = [];
	const seenNames = new Set<AgentOrganName>();
	for (const input of inputs) {
		const organName = input.name;
		if (!(organName in ORGAN_SPECS)) {
			throw new Error(`Unsupported organ "${organName}".`);
		}
		if (seenNames.has(organName)) {
			throw new Error(`Duplicate organ "${organName}" in agent definition.`);
		}
		seenNames.add(organName);

		const spec = ORGAN_SPECS[organName];
		if (spec.availability === "root" && role !== "root") {
			throw new Error(`Organ "${organName}" is only available to root agents.`);
		}

		const actions = normalizeOrganActions(input.actions, organName);
		if (actions.length === 0) {
			throw new Error(`Organ "${organName}" must enable at least one action.`);
		}

		const toolNames = new Set<BuiltInToolName>();
		for (const action of actions) {
			const actionSpec = spec.actions[action];
			if (!actionSpec) {
				throw new Error(
					`Unsupported action "${organName}.${action}". Supported actions: ${getSupportedAgentOrganActions(organName).join(", ")}`,
				);
			}
			for (const toolName of actionSpec.toolNames) {
				toolNames.add(toolName);
			}
		}

		compiled.push({
			name: organName,
			actions,
			toolNames: Array.from(toolNames),
		});
	}

	return compiled;
}

export function listToolNamesForOrgans(organs: CompiledAgentOrganDefinition[]): string[] {
	const toolNames = new Set<string>();
	for (const organ of organs) {
		for (const toolName of organ.toolNames) {
			toolNames.add(toolName);
		}
	}
	return Array.from(toolNames);
}

export function getCompiledAgentOrgan(
	definition: CompiledAgentDefinition | undefined,
	name: AgentOrganName,
): CompiledAgentOrganDefinition | undefined {
	return definition?.organs.find((organ) => organ.name === name);
}

export function getBuiltInToolActionMetadata(toolName: string): AgentActionMetadata | undefined {
	for (const organName of getSupportedAgentOrganNames()) {
		const spec = ORGAN_SPECS[organName];
		for (const [actionName, actionSpec] of Object.entries(spec.actions)) {
			if (actionSpec.toolNames.includes(toolName as BuiltInToolName)) {
				return {
					kind: spec.kind,
					capability: organName,
					availability: spec.availability,
					description: `${organName}.${actionName}`,
				};
			}
		}
	}
	return undefined;
}

export function decorateBuiltInToolDefinition<TDefinition extends { action?: AgentActionMetadata }>(
	toolName: string,
	definition: TDefinition,
): TDefinition {
	const action = getBuiltInToolActionMetadata(toolName);
	if (!action) {
		return definition;
	}

	return {
		...definition,
		action: definition.action
			? {
					...action,
					...definition.action,
				}
			: action,
	};
}
