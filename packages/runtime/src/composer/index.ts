import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";

export {
	type AssembleDirectiveContextInput,
	type AssembledDirectiveContext,
	assembleDirectiveContext,
	type DirectiveAssemblyAudit,
	type DirectiveAuditEntry,
	type DirectiveEventContext,
	type DirectiveKind,
	type DirectiveRuntimeMetadata,
	type RuntimeDirective,
} from "./directive-context-assembler.js";

export interface RuntimeOrganBinding {
	name: string;
	actions: string[];
	toolNames: string[];
}

export interface RuntimeComposition {
	agent: {
		name: string;
		model?: CompiledAgentDefinition["model"];
	};
	organs: RuntimeOrganBinding[];
}

export function composeRuntime(definition: CompiledAgentDefinition): RuntimeComposition {
	return {
		agent: {
			name: definition.name,
			model: definition.model,
		},
		organs: definition.organs.map((organ) => ({
			name: organ.name,
			actions: [...organ.actions],
			toolNames: [...organ.toolNames],
		})),
	};
}
