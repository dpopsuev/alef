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

describe("buildModel: producer/model [provider]", { tags: ["unit"] }, () => {
	it("parses producer/model without override", () => {
		const model = buildModel("anthropic/claude-sonnet-4-5");
		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe("claude-sonnet-4-5");
	});

	it("applies [provider] override to a catalog model", () => {
		const model = buildModel("anthropic/claude-sonnet-4-5 [google-vertex]");
		expect(model.provider).toBe("google-vertex");
		expect(model.id).toBe("claude-sonnet-4-5");
		expect(model.api).toBe("google-vertex");
	});

	it("applies [provider] override to a synthetic model", () => {
		const warnings: string[] = [];
		setModelLogger({ warn: (m) => warnings.push(m), error: () => {} });

		const model = buildModel("deepseek/deepseek-chat [openrouter]");
		expect(model.provider).toBe("openrouter");
		expect(model.id).toBe("deepseek-chat");

		setModelLogger({
			warn: (msg) => process.stderr.write(`[model] warning: ${msg}\n`),
			error: (msg) => process.stderr.write(`[model] error: ${msg}\n`),
		});
	});

	it("preserves model metadata when routing via provider", () => {
		const direct = buildModel("anthropic/claude-sonnet-4-5");
		const routed = buildModel("anthropic/claude-sonnet-4-5 [google-vertex]");
		expect(routed.name).toBe(direct.name);
		expect(routed.contextWindow).toBe(direct.contextWindow);
		expect(routed.reasoning).toBe(direct.reasoning);
		expect(routed.cost).toEqual(direct.cost);
	});

	it("no-op when [provider] matches the producer", () => {
		const model = buildModel("anthropic/claude-sonnet-4-5 [anthropic]");
		expect(model.provider).toBe("anthropic");
		expect(model.api).toBe("anthropic-messages");
	});
});
