import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-adapter-agent";
import { createFactoryAdapter } from "@dpopsuev/alef-adapter-factory";
import { createSkillsAdapter } from "@dpopsuev/alef-adapter-skills";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { completeSimple } from "@dpopsuev/alef-llm";
import { buildDelegationStack } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";

export type { BlueprintStack, BlueprintStackOptions };

export async function createCodingAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });
	const factoryAdapter = createFactoryAdapter({ cwd: opts.cwd });

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
			const response = await completeSimple(opts.model, {
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

	const { adapters, pipeline } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsAdapter, factoryAdapter as unknown as Adapter],
		summarize: llmSummarize,
		adapters: { createAgentAdapter, strategyRegistry, createCompactionStage, createSessionContextStage },
	});

	return { adapters, pipeline };
}
