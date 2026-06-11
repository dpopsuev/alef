import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createAlefApiOrgan } from "../src/organ.js";

describe.skipIf(!HAVE_REAL_LLM)("organ-alef — real LLM E2E", { tags: ["real-llm"] }, () => {
	it("LLM fetches running Alef config using alef.config.get", async () => {
		const session = createE2eSession([createAlefApiOrgan({ dialogEventType: "llm.input" })]);
		const { reply, events } = await session.send(
			"Use alef.config.get to fetch the current Alef configuration and summarise what model it uses. You MUST call alef.config.get.",
		);

		expect(reply.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "tool-start" && e.name.includes("alef.config"))).toBe(true);

		session.dispose();
	}, 60_000);
});
