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
import { createSkillsOrgan } from "@dpopsuev/alef-organ-skills";
import { createWireOrgan } from "@dpopsuev/alef-organ-workflow";
import { buildOrganDirectives, createToolShellOrgan, InProcessStrategy } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";

export type { BlueprintStack, BlueprintStackOptions };

const EXPLORE_ORGANS = [
	{ name: "fs", actions: [] as string[], toolNames: [] as string[] },
	{ name: "web", actions: [] as string[], toolNames: [] as string[] },
];

const EXPLORE_SYSTEM_PROMPT = `Read-only exploration agent. Read files, search code, fetch URLs, report findings.
NEVER write files. NEVER modify state. NEVER execute commands that change anything.
NEVER use emojis. Start with the finding. No filler, no preamble.
Read files before describing them. Batch parallel reads.
Your response IS the return value — factual, structured, under 500 words.`;

const GENERAL_SYSTEM_PROMPT = `General-purpose Alef subagent.
NEVER create files for research, analysis, summaries, or reports. Report in chat as prose.
NEVER use emojis. No filler. No preamble. Start with the finding.
NEVER use git commit --no-verify or skip pre-commit hooks.
ALWAYS read a file with fs.read before editing it with fs.edit.
ALWAYS call tools.describe(["tool-name"]) before first use of any tool.
Batch parallel reads. Answer the question first.`;

export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	const { cwd, model } = opts;
	const materialiOpts = { cwd };

	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
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
	if (sessionStore) {
		pipeline.addStage(
			"memory",
			createSessionContextStage({
				sessionStore: () => sessionStore,
				contextWindow: model.contextWindow,
			}),
		);
	}

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

	const wireOrgan = createWireOrgan({
		cwd,
		async dispatch(text, profile, modelOverride) {
			const session = factory({
				organs: profile === "explore" ? exploreOrgans : generalOrgans,
				systemPrompt: profile === "explore" ? EXPLORE_SYSTEM_PROMPT : GENERAL_SYSTEM_PROMPT,
				modelOverride,
			});
			try {
				return await session.send(text, "human", 600_000);
			} finally {
				session.dispose();
			}
		},
		async judge(prompt, modelOverride) {
			const session = factory({
				organs: exploreOrgans,
				systemPrompt:
					"You are a code reviewer. Score the input 0-10 and provide feedback. Return JSON: { score: number, feedback: string }",
				modelOverride: modelOverride ?? "claude-haiku-4-5",
			});
			try {
				const reply = await session.send(prompt, "human", 60_000);
				try {
					const parsed = JSON.parse(reply) as { score: number; feedback: string };
					return { score: parsed.score ?? 5, feedback: parsed.feedback ?? reply };
				} catch {
					return { score: 5, feedback: reply };
				}
			} finally {
				session.dispose();
			}
		},
	});

	let signalPublish: ((type: string, payload: Record<string, unknown>) => void) | undefined;
	let lastTotalTokens = 0;
	pipeline.addStage(
		"compactor",
		createCompactionStage({
			contextWindow: model.contextWindow,
			publishSignal: (type, payload) => signalPublish?.(type, payload),
			getLastTokenCount: () => lastTotalTokens,
		}),
	);
	const origMount = pipeline.mount.bind(pipeline);
	(pipeline as { mount: typeof pipeline.mount }).mount = (nerve) => {
		signalPublish = (type, payload) => nerve.signal.publish({ type, payload, correlationId: "" });
		nerve.signal.subscribe("llm.token-usage", (event) => {
			const usage = (event as { payload?: { usage?: { totalTokens?: number } } }).payload?.usage;
			if (usage?.totalTokens) lastTotalTokens = usage.totalTokens;
		});
		return origMount(nerve);
	};

	const filteredDomain = domainOrgans.filter(
		(o) => !["agent", "factory", "skills", "compactor", "workflow"].includes(o.name),
	);
	const allOrgans = [...filteredDomain, skillsOrgan, agentOrgan as unknown as Organ, wireOrgan];
	const toolShell = createToolShellOrgan({
		tools: allOrgans.flatMap((o) => o.tools),
		getTools: () => allOrgans.flatMap((o) => o.tools),
		organDirectives: buildOrganDirectives(allOrgans),
	});

	const organs: Organ[] = [...allOrgans, toolShell, pipeline as unknown as Organ];

	return { organs, pipeline };
}
