import { resolveTier } from "@dpopsuev/alef-agent/model";
import { describe, expect, it } from "vitest";
import type { AlefConfig } from "../src/config.js";

const WORK_CONFIG: AlefConfig = {
	profile: "work",
	profiles: {
		work: {
			providers: ["anthropic"],
			default: "anthropic/claude-sonnet-4-5",
			tiers: {
				strong: "anthropic/claude-opus-4-8",
				default: "anthropic/claude-sonnet-4-5",
				fast: "anthropic/claude-haiku-4-5",
			},
		},
		china: {
			providers: ["openrouter"],
			models: ["deepseek.*"],
			default: "openrouter/deepseek/deepseek-chat-v3",
		},
	},
};

describe("resolveTier", () => {
	it("returns the strong model from active profile", () => {
		expect(resolveTier(WORK_CONFIG, "strong")).toBe("anthropic/claude-opus-4-8");
	});

	it("returns the default model from active profile", () => {
		expect(resolveTier(WORK_CONFIG, "default")).toBe("anthropic/claude-sonnet-4-5");
	});

	it("returns the fast model from active profile", () => {
		expect(resolveTier(WORK_CONFIG, "fast")).toBe("anthropic/claude-haiku-4-5");
	});

	it("falls back to profile.default when no tiers defined", () => {
		const cfg: AlefConfig = {
			profile: "china",
			profiles: WORK_CONFIG.profiles,
		};
		expect(resolveTier(cfg, "strong")).toBe("openrouter/deepseek/deepseek-chat-v3");
	});

	it("returns undefined when no profile active", () => {
		expect(resolveTier({}, "strong")).toBeUndefined();
	});

	it("returns undefined when profile has no tiers and no default", () => {
		const cfg: AlefConfig = {
			profile: "bare",
			profiles: { bare: { providers: ["anthropic"] } },
		};
		expect(resolveTier(cfg, "fast")).toBeUndefined();
	});
});
