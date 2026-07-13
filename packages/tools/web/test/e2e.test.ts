import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createWebAdapter } from "../src/adapter.js";

describe.skipIf(!HAVE_REAL_LLM)("web — real LLM E2E", { tags: ["real-llm"] }, () => {
	it("LLM fetches a URL and extracts content using web.fetch", async () => {
		const session = createE2eSession([createWebAdapter()]);
		const { reply, events } = await session.send(
			"Fetch the URL https://example.com and tell me the page title. You MUST use the web.fetch tool.",
		);
		// example.com page title is "Example Domain"
		expect(reply.toLowerCase()).toMatch(/example\s*domain|example\.com/i);
		expect(events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("web"))).toBe(
			true,
		);
		session.dispose();
	}, 60_000);
});
