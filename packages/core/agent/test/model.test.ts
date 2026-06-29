import { describe, expect, it } from "vitest";
import { buildModel, setModelLogger } from "@dpopsuev/alef-agent/model";

describe("ModelLogger port", { tags: ["unit"] }, () => {
	it("setModelLogger routes warnings through the injected logger", () => {
		const warnings: string[] = [];
		setModelLogger({
			warn: (msg) => warnings.push(msg),
			error: (msg) => warnings.push(`ERROR: ${msg}`),
		});

		buildModel("nonexistent-model-xyz");

		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("nonexistent-model-xyz");

		setModelLogger({
			warn: (msg) => process.stderr.write(`[model] warning: ${msg}\n`),
			error: (msg) => process.stderr.write(`[model] error: ${msg}\n`),
		});
	});
});
