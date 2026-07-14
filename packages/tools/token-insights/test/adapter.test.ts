import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createTokenInsights } from "../src/index.js";

adapterComplianceSuite(() => createTokenInsights());

describe("token-insights adapter", { tags: ["compliance"] }, () => {
	it("exposes analysis tools", () => {
		const adapter = createTokenInsights();
		expect(adapter.name).toBe("token-insights");
		expect(adapter.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining([
				"tokens.summary",
				"tokens.top-consumers",
				"tokens.trends",
				"tokens.cache-analysis",
				"tokens.export",
				"tokens.optimize",
			]),
		);
	});

	it("tokens.summary returns empty notice when no telemetry", async () => {
		const f = new BusFixture();
		f.mount(createTokenInsights());
		const result = await f.call("tokens.summary", {});
		expect(result.isError).toBe(false);
		expect(result.payload.records).toEqual([]);
		const display = (result.payload as { _display?: { text?: string } })._display?.text ?? "";
		expect(display).toContain("No token usage data found");
		f.dispose();
	});
});
