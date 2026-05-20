import type { CanonicalLane, ProtocolSeam } from "../board/protocol.js";

export type DirectiveKind = "pre" | "system" | "skill";

export interface RuntimeDirective {
	id: string;
	kind: DirectiveKind;
	content: string;
	enabled?: boolean;
	priority?: number;
	source?: string;
}

export interface DirectiveEventContext {
	kind: string;
	summary: string;
	lane?: CanonicalLane;
	seam?: ProtocolSeam;
	correlationId?: string;
}

export interface DirectiveRuntimeMetadata {
	runtimeId?: string;
	sessionId?: string;
	model?: string;
	tools?: string[];
	organs?: string[];
}

export interface DirectiveAuditEntry {
	id: string;
	kind: DirectiveKind;
	source?: string;
	reason?: string;
}

export interface DirectiveAssemblyAudit {
	applied: DirectiveAuditEntry[];
	dropped: DirectiveAuditEntry[];
}

export interface AssembleDirectiveContextInput {
	basePrompt: string;
	directives?: RuntimeDirective[];
	eventContext?: DirectiveEventContext[];
	runtimeMetadata?: DirectiveRuntimeMetadata;
	maxEventContextItems?: number;
}

export interface AssembledDirectiveContext {
	prompt: string;
	audit: DirectiveAssemblyAudit;
}

const DIRECTIVE_KIND_ORDER: Record<DirectiveKind, number> = {
	pre: 0,
	system: 1,
	skill: 2,
};

function compareDirectives(left: RuntimeDirective, right: RuntimeDirective): number {
	const leftPriority = left.priority ?? 0;
	const rightPriority = right.priority ?? 0;
	if (leftPriority !== rightPriority) {
		return rightPriority - leftPriority;
	}
	const kindOrder = DIRECTIVE_KIND_ORDER[left.kind] - DIRECTIVE_KIND_ORDER[right.kind];
	if (kindOrder !== 0) {
		return kindOrder;
	}
	return left.id.localeCompare(right.id);
}

function normalizeDirectiveContent(content: string): string {
	return content.trim();
}

function renderDirectivesSection(directives: RuntimeDirective[]): string {
	if (directives.length === 0) {
		return "";
	}
	const grouped: Record<DirectiveKind, RuntimeDirective[]> = {
		pre: [],
		system: [],
		skill: [],
	};
	for (const directive of directives) {
		grouped[directive.kind].push(directive);
	}

	const sections: string[] = [];
	for (const kind of ["pre", "system", "skill"] as const) {
		if (grouped[kind].length === 0) {
			continue;
		}
		const label = kind === "pre" ? "Pre-Prompts" : kind === "system" ? "System Prompts" : "Skills";
		const content = grouped[kind]
			.map((directive) => `### ${directive.id}\n${normalizeDirectiveContent(directive.content)}`)
			.join("\n\n");
		sections.push(`## Directive Layer: ${label}\n${content}`);
	}

	return sections.join("\n\n");
}

function renderEventContextSection(events: DirectiveEventContext[], maxItems: number): string {
	if (events.length === 0 || maxItems <= 0) {
		return "";
	}
	const selected = events.slice(0, maxItems);
	const lines = selected.map((event) => {
		const lane = event.lane ? ` lane=${event.lane}` : "";
		const seam = event.seam ? ` seam=${event.seam}` : "";
		const correlation = event.correlationId ? ` correlation=${event.correlationId}` : "";
		return `- ${event.kind}:${lane}${seam}${correlation} ${event.summary}`.replace(": ", ": ");
	});
	return `## Event Context\n${lines.join("\n")}`;
}

function renderRuntimeMetadataSection(metadata: DirectiveRuntimeMetadata): string {
	const parts: string[] = [];
	if (metadata.runtimeId) {
		parts.push(`- runtimeId: ${metadata.runtimeId}`);
	}
	if (metadata.sessionId) {
		parts.push(`- sessionId: ${metadata.sessionId}`);
	}
	if (metadata.model) {
		parts.push(`- model: ${metadata.model}`);
	}
	if (metadata.organs && metadata.organs.length > 0) {
		parts.push(`- organs: ${metadata.organs.join(", ")}`);
	}
	if (metadata.tools && metadata.tools.length > 0) {
		parts.push(`- tools: ${metadata.tools.join(", ")}`);
	}
	if (parts.length === 0) {
		return "";
	}
	return `## Runtime Metadata\n${parts.join("\n")}`;
}

export function assembleDirectiveContext(input: AssembleDirectiveContextInput): AssembledDirectiveContext {
	const directives = [...(input.directives ?? [])].sort(compareDirectives);
	const audit: DirectiveAssemblyAudit = {
		applied: [],
		dropped: [],
	};
	const applied: RuntimeDirective[] = [];
	for (const directive of directives) {
		if (directive.enabled === false) {
			audit.dropped.push({
				id: directive.id,
				kind: directive.kind,
				source: directive.source,
				reason: "disabled",
			});
			continue;
		}
		if (normalizeDirectiveContent(directive.content).length === 0) {
			audit.dropped.push({
				id: directive.id,
				kind: directive.kind,
				source: directive.source,
				reason: "empty",
			});
			continue;
		}
		applied.push(directive);
		audit.applied.push({
			id: directive.id,
			kind: directive.kind,
			source: directive.source,
		});
	}

	const sections: string[] = [input.basePrompt];
	const directiveSection = renderDirectivesSection(applied);
	if (directiveSection.length > 0) {
		sections.push(directiveSection);
	}

	const eventSection = renderEventContextSection(input.eventContext ?? [], input.maxEventContextItems ?? 12);
	if (eventSection.length > 0) {
		sections.push(eventSection);
	}

	const metadataSection = renderRuntimeMetadataSection(input.runtimeMetadata ?? {});
	if (metadataSection.length > 0) {
		sections.push(metadataSection);
	}

	return {
		prompt: sections.join("\n\n"),
		audit,
	};
}
