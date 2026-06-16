import {
	type BlueprintStack,
	type BlueprintStackOptions,
	DEFAULT_COMPILED_DEFINITION,
	materializeBlueprint,
	materializeDefaultOrgans,
} from "@dpopsuev/alef-agent-blueprint";
import type { Organ } from "@dpopsuev/alef-kernel";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import { createAgentOrgan, strategyRegistry } from "@dpopsuev/alef-organ-agent";
import { createFactoryOrgan } from "@dpopsuev/alef-organ-factory";
import { createMemoryOrgan } from "@dpopsuev/alef-organ-memory";
import { createSkillsOrgan } from "@dpopsuev/alef-organ-skills";
import { buildOrganDirectives, createToolShellOrgan } from "@dpopsuev/alef-organ-toolshell";
import { InProcessStrategy } from "@dpopsuev/alef-runtime";

export type { BlueprintStack, BlueprintStackOptions };

const EXPLORE_ORGANS = [
	{ name: "fs", actions: [] as string[], toolNames: [] as string[] },
	{ name: "web", actions: [] as string[], toolNames: [] as string[] },
];

const EXPLORE_SYSTEM_PROMPT = `You are a read-only exploration agent. Your only job is to read files, search code, and fetch URLs, then report findings concisely.

Rules — follow these exactly:
- No emojis. Never. In any part of your response.
- No filler ("Great!", "Certainly!", "Let me look at..."). Start with the finding.
- No preamble. Do not narrate what you are about to do. Run the tool, return the result.
- Never write files, modify state, or execute commands that change anything.
- Return absolute file paths when listing files.
- Read files before describing them. Never claim what a file contains without reading it.
- If the caller asks you to read multiple files in parallel, do so — do not serialize reads you can batch.`;

const GENERAL_SYSTEM_PROMPT = `You are a general-purpose Alef subagent with full tool access.

Tool dispatch rules — follow these exactly:
- You have access to an Alef tool catalog. Use the Alef tool dispatch mechanism — do NOT output XML tags like <read_file> or <bash> in your response text.
- Before calling any tool you have not used yet, call tools.describe(["tool-name"]) to get its input schema.
- Call tools.describe([]) to see all available tools when unsure what is available.
- Issue parallel tool calls when reading multiple files or making independent requests. Never serialize reads you can batch.
- Read files before describing their contents. Never claim what a file contains without first reading it.

Behavioral rules:
- No emojis. No filler ("Great!", "Certainly!"). Start with the finding, not a preamble.
- No preamble. Run the tool instead of narrating that you will run it.
- Never create files to deliver findings. Report all results in the chat as prose.
- Answer the question first. Elaboration follows; it never precedes.`;

export async function createCodingAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	const { cwd, model } = opts;
	const materialiOpts = { cwd };

	if (!opts.subagentFactory) {
		throw new Error(
			"BlueprintStackOptions.subagentFactory is required. The runner must inject the subagent factory.",
		);
	}
	const factory = opts.subagentFactory;

	const [resolvedDomainOrgans, { organs: exploreOrgans }, { organs: generalOrgans }] = await Promise.all([
		opts.domainOrgans ? Promise.resolve(opts.domainOrgans) : materializeDefaultOrgans(cwd),
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, organs: [...EXPLORE_ORGANS] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);
	const domainOrgans = resolvedDomainOrgans;

	const pipeline = createContextAssemblyPipeline();

	const { sessionStore } = opts;
	const memoryOrgan = createMemoryOrgan({
		sessionStore: sessionStore ? () => sessionStore : undefined,
		contextWindow: model.contextWindow,
	});

	const skillsOrgan = createSkillsOrgan({ cwd });

	const exploreStrategy = new InProcessStrategy(exploreOrgans, factory, EXPLORE_SYSTEM_PROMPT);
	const generalStrategy = new InProcessStrategy(generalOrgans, factory, GENERAL_SYSTEM_PROMPT);
	strategyRegistry.register("explore", exploreStrategy);
	strategyRegistry.register("general", generalStrategy);

	const agentOrgan = createAgentOrgan({
		cwd,
		strategies: {
			explore: exploreStrategy,
			general: generalStrategy,
		},
		replyEvent: "llm.response",
		writableRoots: opts.writableRoots,
		materializeOrgans: async (names) => {
			const { organs } = await materializeBlueprint(
				{
					...DEFAULT_COMPILED_DEFINITION,
					organs: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
				materialiOpts,
			);
			return organs;
		},
		createAdHocSession: factory,
	});

	const factoryOrgan = createFactoryOrgan({ cwd });

	const filteredDomain = domainOrgans.filter((o) => !["agent", "factory", "skills"].includes(o.name));
	const allOrgans = [
		...filteredDomain,
		memoryOrgan,
		skillsOrgan,
		agentOrgan as unknown as Organ,
		factoryOrgan as unknown as Organ,
	];
	const toolShell = createToolShellOrgan({
		tools: allOrgans.flatMap((o) => o.tools),
		getTools: () => allOrgans.flatMap((o) => o.tools),
		organDirectives: buildOrganDirectives(allOrgans),
	});

	const organs: Organ[] = [...allOrgans, toolShell, pipeline as unknown as Organ];

	return { organs, pipeline };
}
