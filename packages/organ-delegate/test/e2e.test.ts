import { randomUUID } from "node:crypto";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";
import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createDelegateOrgan } from "../src/organ.js";

describe.skipIf(!HAVE_REAL_LLM)("organ-delegate — real LLM E2E", () => {
	it("LLM delegates a task via agent.run and uses the subagent reply", async () => {
		const token = randomUUID().slice(0, 8).toUpperCase();

		let delegatedText = "";
		const stubStrategy: ExecutionStrategy = {
			async send(text, _sender, _timeoutMs, onChunk) {
				delegatedText = text;
				onChunk?.(`The token is ${token}`);
				return `The token is ${token}`;
			},
		};

		const delegateOrgan = createDelegateOrgan({ strategies: { explore: stubStrategy } });
		const session = createE2eSession([delegateOrgan]);

		const { reply, events } = await session.send(
			`You have access to agent.run. Use agent.run with profile 'explore' to ask the subagent: "What is the token?" Then tell me what the subagent said. You MUST call agent.run.`,
		);

		expect(reply).toContain(token);
		expect(events.some((e) => e.type === "tool-start" && e.name.includes("agent"))).toBe(true);

		void delegatedText;
		session.dispose();
	}, 90_000);
});
