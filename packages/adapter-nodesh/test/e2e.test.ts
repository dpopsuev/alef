import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createNodeshAdapter } from "../src/adapter.js";

describe.skipIf(!HAVE_REAL_LLM)("organ-nodesh — real LLM E2E", { tags: ["real-llm"] }, () => {
	it("LLM evaluates a JS expression using nodesh.eval and reports the result", async () => {
		const session = createE2eSession([createNodeshAdapter({ cwd: process.cwd() })]);
		const { reply, events } = await session.send(
			"Use nodesh.eval to compute 2 ** 10 and tell me the result. You MUST use the nodesh.eval tool.",
		);

		expect(reply).toContain("1024");
		expect(events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("nodesh"))).toBe(
			true,
		);

		session.dispose();
	}, 60_000);
});
