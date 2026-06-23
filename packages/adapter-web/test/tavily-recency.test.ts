/**
 * Tavily recency — timeRange and topic exposed in web.search schema + directives.
 *
 * Given/When/Then:
 *   Given the web organ is mounted
 *   When the tool schema is inspected
 *   Then web.search accepts timeRange and topic parameters
 *   And the directives mention timeRange for recent news
 */

import { describe, expect, it } from "vitest";
import { createWebOrgan } from "../src/adapter.js";

describe("web.search — timeRange and topic parameters", { tags: ["unit"] }, () => {
	it("web.search tool schema includes timeRange field", () => {
		const organ = createWebOrgan();
		const tool = organ.tools.find((t) => t.name === "web.search");
		expect(tool, "web.search tool must exist").toBeDefined();

		const schema = tool!.inputSchema;
		const parsed = schema.safeParse({ query: "test", timeRange: "month" });
		expect(parsed.success, "timeRange: 'month' should be valid").toBe(true);
	});

	it("web.search tool schema includes topic field", () => {
		const organ = createWebOrgan();
		const tool = organ.tools.find((t) => t.name === "web.search");
		const schema = tool!.inputSchema;

		const parsed = schema.safeParse({ query: "test", topic: "news" });
		expect(parsed.success, "topic: 'news' should be valid").toBe(true);
	});

	it("timeRange rejects invalid values", () => {
		const organ = createWebOrgan();
		const tool = organ.tools.find((t) => t.name === "web.search");
		const schema = tool!.inputSchema;

		const parsed = schema.safeParse({ query: "test", timeRange: "century" });
		expect(parsed.success, "timeRange: 'century' should be invalid").toBe(false);
	});

	it("organ directives mention timeRange for recent news", () => {
		const organ = createWebOrgan();
		const directivesText = organ.directives?.join("\n") ?? "";
		expect(directivesText).toMatch(/timeRange/i);
	});
});
