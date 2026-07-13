import { describe, expect, it } from "vitest";
import { parseStreamRulesEnv } from "../src/build-llm.js";

describe("parseStreamRulesEnv", { tags: ["unit"] }, () => {
	it("returns empty for missing or invalid input", () => {
		expect(parseStreamRulesEnv(undefined)).toEqual([]);
		expect(parseStreamRulesEnv("")).toEqual([]);
		expect(parseStreamRulesEnv("not-json")).toEqual([]);
		expect(parseStreamRulesEnv("{}")).toEqual([]);
	});

	it("parses valid rule objects", () => {
		const rules = parseStreamRulesEnv(
			JSON.stringify([
				{ id: "a", pattern: "oops", on: "text", message: "retry" },
				{ id: "bad" },
				{ id: "b", pattern: "x", message: "y" },
			]),
		);
		expect(rules).toEqual([
			{ id: "a", pattern: "oops", on: "text", message: "retry" },
			{ id: "b", pattern: "x", on: "text", message: "y" },
		]);
	});
});
