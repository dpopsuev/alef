import { createSkillsAdapter } from "@dpopsuev/alef-adapter-skills";
import { createWireAdapter } from "@dpopsuev/alef-adapter-workflow";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "./delegation-stack.js";

export type { BlueprintStack, BlueprintStackOptions };

export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}
	const factory = opts.subagentFactory;

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });

	const { adapters, pipeline, exploreAdapters, generalAdapters } = await buildDelegationStack({
		cwd: opts.cwd,
		factory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsAdapter],
		excludeNames: ["workflow"],
	});

	const wireAdapter = createWireAdapter({
		cwd: opts.cwd,
		async dispatch(text, profile, modelOverride) {
			const session = factory({
				adapters: profile === "explore" ? exploreAdapters : generalAdapters,
				systemPrompt: profile === "explore" ? "Read-only exploration agent. Report findings concisely." : undefined,
				modelOverride,
			});
			try {
				return await session.send!(text, 600_000);
			} finally {
				session.dispose();
			}
		},
		async judge(prompt, modelOverride) {
			const session = factory({
				adapters: exploreAdapters,
				systemPrompt:
					"You are a code reviewer. Score the input 0-10 and provide feedback. Return JSON: { score: number, feedback: string }",
				modelOverride: modelOverride ?? "claude-haiku-4-5",
			});
			try {
				const reply = await session.send!(prompt, 60_000);
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

	adapters.splice(adapters.length - 2, 0, wireAdapter as unknown as Adapter);

	return { adapters, pipeline };
}
