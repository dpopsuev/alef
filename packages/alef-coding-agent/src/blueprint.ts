import { createAgentOrgan, strategyRegistry } from "@dpopsuev/alef-adapter-agent";
import { createFactoryOrgan } from "@dpopsuev/alef-adapter-factory";
import { createSkillsOrgan } from "@dpopsuev/alef-adapter-skills";
import {
	type BlueprintStack,
	type BlueprintStackOptions,
	DEFAULT_COMPILED_DEFINITION,
	materializeBlueprint,
	materializeDefaultOrgans,
} from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import { completeSimple } from "@dpopsuev/alef-llm";
import { buildOrganDirectives, createToolShellOrgan, InProcessStrategy } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";

export type { BlueprintStack, BlueprintStackOptions };

const EXPLORE_ORGANS = [
	{ name: "fs", actions: [] as string[], toolNames: ["fs.read", "fs.grep", "fs.find"] },
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

	const factoryOrgan = createFactoryOrgan({ cwd });
	let signalPublish: ((type: string, payload: Record<string, unknown>) => void) | undefined;
	let lastTotalTokens = 0;

	const llmSummarize = async (messages: readonly unknown[]): Promise<string> => {
		const conversation = messages
			.map((m) => {
				const msg = m as { role?: string; content?: string | Array<{ text?: string }> };
				const role = msg.role ?? "unknown";
				let text = "";
				if (typeof msg.content === "string") text = msg.content;
				else if (Array.isArray(msg.content))
					text = msg.content
						.filter((b): b is { text: string } => typeof b.text === "string")
						.map((b) => b.text)
						.join(" ");
				return `[${role}] ${text.slice(0, 500)}`;
			})
			.join("\n");

		try {
			const response = await completeSimple(model, {
				systemPrompt:
					"You are a context summarization assistant. Read the conversation and produce a structured summary. Do NOT continue the conversation.",
				messages: [
					{
						role: "user" as const,
						content: `<conversation>\n${conversation}\n</conversation>\n\nSummarize this conversation. Use this format:\n\n## Goal\n[What the user is trying to accomplish]\n\n## Progress\n- [x] [Completed items]\n- [ ] [In progress items]\n\n## Key Decisions\n- [Important decisions made]\n\n## Next Steps\n1. [What should happen next]\n\nKeep it concise. Preserve exact file paths and function names.`,
						timestamp: Date.now(),
					},
				],
			});
			const text = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			return text || "[Context compacted — earlier turns summarized]";
		} catch {
			return messages
				.slice(0, 10)
				.map((m) => {
					const msg = m as { role?: string; content?: string };
					return `- ${msg.role ?? "?"}: ${typeof msg.content === "string" ? msg.content.split("\n")[0]?.slice(0, 120) : "..."}`;
				})
				.join("\n");
		}
	};

	pipeline.addStage(
		"compactor",
		createCompactionStage({
			contextWindow: model.contextWindow,
			summarize: llmSummarize,
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

	const filteredDomain = domainOrgans.filter((o) => !["agent", "factory", "skills", "compactor"].includes(o.name));
	const allOrgans = [
		...filteredDomain,
		skillsOrgan,
		agentOrgan as unknown as Adapter,
		factoryOrgan as unknown as Adapter,
	];
	const toolShell = createToolShellOrgan({
		tools: allOrgans.flatMap((o) => o.tools),
		getTools: () => allOrgans.flatMap((o) => o.tools),
		organDirectives: buildOrganDirectives(allOrgans),
	});

	const organs: Adapter[] = [...allOrgans, toolShell, pipeline as unknown as Adapter];

	return { organs, pipeline };
}
