import { describe, expect, it, vi } from "vitest";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/contributions";
import { buildDelegationStack } from "../src/delegation.js";
import type { SubagentFactory } from "../src/subagent-port.js";

function stubAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		mount: () => () => {},
		subscriptions: { command: [], event: [], notification: [] },
		sources: [],
	};
}

const stubStage: ContextAssemblyHandler = async () => ({});

describe("buildDelegationStack", { tags: ["unit"] }, () => {
	it("builds a stack from stub adapters without materializer", async () => {
		const factory: SubagentFactory = () => ({
			send: async () => "ok",
			dispose: async () => {},
		});
		const createAgentAdapter = vi.fn((_opts: Record<string, unknown>) => stubAdapter("agent"));
		const createCompactionStage = vi.fn(() => stubStage);
		const createSessionContextStage = vi.fn(() => stubStage);
		const materializeAdapters = vi.fn(async (names: string[]) => names.map(stubAdapter));

		const stack = await buildDelegationStack({
			cwd: "/tmp",
			factory,
			contextWindow: 1000,
			domainAdapters: [stubAdapter("fs"), stubAdapter("shell")],
			exploreAdapters: [stubAdapter("fs")],
			generalAdapters: [stubAdapter("fs"), stubAdapter("shell")],
			materializeAdapters,
			adapters: {
				createAgentAdapter,
				createCompactionStage,
				createSessionContextStage,
			},
		});

		expect(stack.exploreAdapters.map((a) => a.name)).toEqual(["fs"]);
		expect(stack.generalAdapters.map((a) => a.name)).toEqual(["fs", "shell"]);
		expect(stack.adapters.some((a) => a.name === "agent")).toBe(true);
		expect(stack.adapters.some((a) => a.name === "fs")).toBe(true);
		expect(createAgentAdapter).toHaveBeenCalledOnce();
		expect(materializeAdapters).not.toHaveBeenCalled();
	});
});
