import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastModel, rememberLastModel } from "../src/model/last-model.js";
import { resolveStartupModel } from "../src/model/resolve.js";

describe("last model preference", { tags: ["unit"] }, () => {
	const previous = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
		alefModel: process.env.ALEF_MODEL,
		apiKey: process.env.ANTHROPIC_API_KEY,
	};
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "alef-last-model-"));
		process.env.XDG_STATE_HOME = join(root, "state");
		process.env.XDG_CONFIG_HOME = join(root, "config");
		process.env.ANTHROPIC_API_KEY = previous.apiKey ?? "sk-test-last-model";
		delete process.env.ALEF_MODEL;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries({
			XDG_STATE_HOME: previous.state,
			XDG_CONFIG_HOME: previous.config,
			ALEF_MODEL: previous.alefModel,
			ANTHROPIC_API_KEY: previous.apiKey,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("rememberLastModel writes XDG state and readLastModel returns it", () => {
		expect(readLastModel()).toBeUndefined();
		rememberLastModel("claude-haiku-4-5");
		expect(readLastModel()).toBe("claude-haiku-4-5");
		expect(readFileSync(join(root, "state", "alef", "last-model"), "utf-8").trim()).toBe("claude-haiku-4-5");
	});

	it("resolveStartupModel prefers last pick over ALEF_MODEL and config.model", () => {
		process.env.ALEF_MODEL = "claude-sonnet-4-5";
		rememberLastModel("claude-haiku-4-5");
		const model = resolveStartupModel({ modelId: undefined, debug: false }, undefined, {
			model: "claude-sonnet-4-5",
		});
		expect(model.id).toBe("claude-haiku-4-5");
	});

	it("CLI --model still wins over last pick", () => {
		rememberLastModel("claude-haiku-4-5");
		const model = resolveStartupModel({ modelId: "claude-sonnet-4-5", debug: false }, undefined, {});
		expect(model.id).toBe("claude-sonnet-4-5");
	});
});
