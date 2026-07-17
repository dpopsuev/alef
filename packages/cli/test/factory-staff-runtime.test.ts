import { randomUUID } from "node:crypto";
import { createFactoryAgentStack } from "@dpopsuev/alef-factory-agent";
import { defineAdapter } from "@dpopsuev/alef-kernel/adapter";
import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";

interface AgentRunResultPayload {
	run: {
		work?: {
			role?: {
				category?: string;
				roleId?: string;
				blueprintId?: string;
			};
		};
	};
}

function agentRunPayload(event: EventMessage): AgentRunResultPayload {
	return event.payload as unknown as AgentRunResultPayload;
}

async function call(bus: InProcessBus, type: string, payload: Record<string, unknown>): Promise<EventMessage> {
	const correlationId = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`timeout: ${type}`));
		}, 5000);
		const off = bus.asBus().event.subscribe(type, (event) => {
			if (event.correlationId !== correlationId) return;
			clearTimeout(timer);
			off();
			resolve(event);
		});
		bus.asBus().command.publish({ type, payload, correlationId });
	});
}

describe("factory staffed runtime profiles", { tags: ["unit"] }, () => {
	it("registers line roles and legacy gensec/2sec as agent.run profiles", async () => {
		const prompts: string[] = [];
		const domainAdapter = defineAdapter("dummy", {}, { description: "dummy", directives: ["test only"] });
		const stack = await createFactoryAgentStack({
			cwd: "/tmp",
			model: { contextWindow: 200_000 } as never,
			domainAdapters: [domainAdapter],
			subagentFactory: ({ systemPrompt }) => ({
				send: async () => {
					prompts.push(systemPrompt ?? "");
					return "role reply";
				},
				dispose: () => {},
			}),
		});
		const agentAdapter = stack.adapters.find((adapter) => adapter.name === "agent");
		expect(agentAdapter).toBeDefined();

		const bus = new InProcessBus();
		const unmount = agentAdapter!.mount(bus.asBus());
		try {
			const coordinator = await call(bus, "agent.run", { text: "coordinate", profile: "coordinator" });
			expect(agentRunPayload(coordinator).run.work?.role).toEqual({
				category: "line",
				roleId: "coordinator",
				blueprintId: "alef-factory-agent",
			});

			const director = await call(bus, "agent.run", { text: "own plan", profile: "director" });
			expect(agentRunPayload(director).run.work?.role).toEqual({
				category: "line",
				roleId: "director",
				blueprintId: "alef-factory-agent",
			});

			const supervisor = await call(bus, "agent.run", { text: "watch line", profile: "supervisor" });
			expect(agentRunPayload(supervisor).run.work?.role).toEqual({
				category: "line",
				roleId: "supervisor",
				blueprintId: "alef-factory-agent",
			});

			const coder = await call(bus, "agent.run", { text: "implement", profile: "worker.coder" });
			expect(agentRunPayload(coder).run.work?.role).toEqual({
				category: "worker",
				roleId: "coder",
				blueprintId: "alef-coding-agent",
			});

			const gensec = await call(bus, "agent.run", { text: "coordinate", profile: "gensec" });
			expect(agentRunPayload(gensec).run.work?.role).toEqual({
				category: "staff",
				roleId: "gensec",
				blueprintId: "gensec",
			});

			const second = await call(bus, "agent.run", { text: "synthesize", profile: "2sec" });
			expect(agentRunPayload(second).run.work?.role).toEqual({
				category: "staff",
				roleId: "2sec",
				blueprintId: "2sec",
			});

			expect(prompts.some((prompt) => prompt.includes("You are the Coordinator"))).toBe(true);
			expect(prompts.some((prompt) => prompt.includes("You are the Director"))).toBe(true);
			expect(prompts.some((prompt) => prompt.includes("You are the Supervisor"))).toBe(true);
			expect(prompts.some((prompt) => prompt.includes("Worker (coder)"))).toBe(true);
			expect(prompts.some((prompt) => prompt.includes("You are GenSec"))).toBe(true);
			expect(prompts.some((prompt) => prompt.includes("You are 2Sec"))).toBe(true);
		} finally {
			unmount();
		}
	});
});
