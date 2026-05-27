/**
 * SkillsOrgan — discovers SKILL.md files and exposes them to the agent.
 *
 * At mount time, scans standard paths for SKILL.md files (agentskills.io).
 * Active skills (not disable-model-invocation) are exposed as organ directives,
 * which the DirectiveContextAssembler injects into the system prompt.
 *
 * Tools:
 *   skills.list    — enumerate all discovered skills with names and descriptions
 *   skills.invoke  — load a user-invocable skill's full instructions into context
 */

import type { CorpusHandlerCtx, Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { defineOrgan, getString } from "@dpopsuev/alef-spine";
import { z } from "zod";
import { discoverSkills, skillsToXml } from "./discovery.js";
import type { Skill } from "./types.js";

export interface SkillsOrganOptions {
	/** Working directory for relative skill path resolution. */
	cwd: string;
	/** Additional skill directories beyond the standard paths. */
	skillsPaths?: string[];
	logger?: OrganLogger;
}

const LIST_TOOL = {
	name: "skills.list",
	description: "List all discovered SKILL.md skills with their names and descriptions.",
	inputSchema: z.object({}),
};

const INVOKE_TOOL = {
	name: "skills.invoke",
	description:
		"Load the full instructions of a user-invocable skill into context. " +
		"Use this when the user explicitly asks for a skill, or when a skill name in the index " +
		"is clearly relevant to the current task.",
	inputSchema: z.object({
		name: z.string().describe("Skill name as shown in skills.list"),
	}),
};

export function createSkillsOrgan(opts: SkillsOrganOptions): Organ {
	// Skills are discovered synchronously at organ construction time.
	// The organ instance lives for the process lifetime so this is a one-time cost.
	const skills: Skill[] = discoverSkills(opts.cwd, opts.skillsPaths ?? []);
	const byName = new Map(skills.map((s) => [s.name, s]));

	// Skills index injected as directive → system prompt (name + description only).
	// Full instructions are loaded on demand via skills.invoke when relevant.
	const activeSkillsXml = skillsToXml(skills);
	const directives: string[] = activeSkillsXml
		? [
				`**Available skills (from SKILL.md discovery)**\n\n` +
					`The following skills are available. Each has specialised instructions for a specific task. ` +
					`Call skills.invoke with the skill name to load the full instructions when a skill is relevant.\n\n` +
					activeSkillsXml,
			]
		: [];

	function handleList(_ctx: CorpusHandlerCtx): Record<string, unknown> {
		return {
			skills: skills.map((s) => ({
				name: s.name,
				description: s.description,
				userInvocable: s.userInvocable,
				disableModelInvocation: s.disableModelInvocation,
				path: s.path,
			})),
			total: skills.length,
		};
	}

	function handleInvoke(ctx: CorpusHandlerCtx): Record<string, unknown> {
		const name = getString(ctx.payload, "name") ?? "";
		const skill = byName.get(name);
		if (!skill) {
			throw new Error(
				`skills.invoke: skill "${name}" not found. ` + `Available: ${[...byName.keys()].join(", ") || "(none)"}`,
			);
		}
		if (!skill.userInvocable) {
			throw new Error(`skills.invoke: skill "${name}" is not user-invocable.`);
		}
		return { name: skill.name, instructions: skill.instructions, path: skill.path };
	}

	// The organ's mount() exposes tools. Directives handle the prompt injection.
	const organ = defineOrgan(
		"skills",
		{
			"motor/skills.list": { tool: LIST_TOOL, handle: (ctx: CorpusHandlerCtx) => Promise.resolve(handleList(ctx)) },
			"motor/skills.invoke": {
				tool: INVOKE_TOOL,
				handle: (ctx: CorpusHandlerCtx) => Promise.resolve(handleInvoke(ctx)),
			},
		},
		{
			logger: opts.logger,
			directives,
			description: `Skills organ: ${skills.length} skill(s) discovered from SKILL.md files.`,
			labels: ["skills", "context", "instructions"],
		},
	);

	return organ;
}
