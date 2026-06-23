import { createSkillsOrgan } from "@dpopsuev/alef-adapter-skills";
import { createWireOrgan } from "@dpopsuev/alef-adapter-workflow";
import { type BlueprintStack, type BlueprintStackOptions, buildDelegationStack } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";

export type { BlueprintStack, BlueprintStackOptions };

export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}
	const factory = opts.subagentFactory;

	const skillsOrgan = createSkillsOrgan({ cwd: opts.cwd });

	const { organs, pipeline, exploreOrgans, generalOrgans } = await buildDelegationStack({
		cwd: opts.cwd,
		factory,
		contextWindow: opts.model.contextWindow,
		domainOrgans: opts.domainOrgans,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsOrgan],
		excludeNames: ["workflow"],
	});

	const wireOrgan = createWireOrgan({
		cwd: opts.cwd,
		async dispatch(text, profile, modelOverride) {
			const session = factory({
				organs: profile === "explore" ? exploreOrgans : generalOrgans,
				systemPrompt: profile === "explore" ? "Read-only exploration agent. Report findings concisely." : undefined,
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

	organs.splice(organs.length - 2, 0, wireOrgan as unknown as Adapter);

	return { organs, pipeline };
}
