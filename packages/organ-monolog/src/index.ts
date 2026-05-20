import type { AgentDiscoursePort, MonologDiscoursePort } from "@dpopsuev/alef-discourse";

export type { MonologDiscoursePort } from "@dpopsuev/alef-discourse";

export function createMonologDiscoursePort(discourse: AgentDiscoursePort): MonologDiscoursePort {
	return {
		createKnowledgeAtom: (request) => discourse.createKnowledgeAtom(request),
		createKnowledgeMolecule: (request) => discourse.createKnowledgeMolecule(request),
		listKnowledgeAtoms: (request) => discourse.listKnowledgeAtoms(request),
		listKnowledgeMolecules: (request) => discourse.listKnowledgeMolecules(request),
	};
}
