import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModel, hasCredentials } from "../src/model.js";

describe("buildModel", () => {
	it("returns a Model with the given id", () => {
		const model = buildModel("claude-haiku-4-5");
		expect(model.id).toBe("claude-haiku-4-5");
	});

	it("resolves known model name", () => {
		const model = buildModel("claude-sonnet-4-5");
		expect(model.name).toBe("Claude Sonnet 4.5");
	});

	it("falls back to id as name for unknown model", () => {
		const model = buildModel("some-unknown-model");
		expect(model.name).toBe("some-unknown-model");
	});

	it("always sets anthropic-messages api and anthropic provider", () => {
		const model = buildModel("claude-haiku-4-5");
		expect(model.api).toBe("anthropic-messages");
		expect(model.provider).toBe("anthropic");
		expect(model.baseUrl).toBe("https://api.anthropic.com");
	});

	it("has sensible context window and token limits", () => {
		const model = buildModel("claude-haiku-4-5");
		expect(model.contextWindow).toBeGreaterThan(0);
		expect(model.maxTokens).toBeGreaterThan(0);
	});
});

describe("hasCredentials", () => {
	let savedApiKey: string | undefined;
	let savedVertexProject: string | undefined;
	let savedRegion: string | undefined;

	beforeEach(() => {
		savedApiKey = process.env.ANTHROPIC_API_KEY;
		savedVertexProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
		savedRegion = process.env.CLOUD_ML_REGION;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
		delete process.env.CLOUD_ML_REGION;
	});

	afterEach(() => {
		if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
		if (savedVertexProject !== undefined) process.env.ANTHROPIC_VERTEX_PROJECT_ID = savedVertexProject;
		if (savedRegion !== undefined) process.env.CLOUD_ML_REGION = savedRegion;
	});

	it("returns false when no credentials are set", () => {
		expect(hasCredentials()).toBe(false);
	});

	it("returns true when ANTHROPIC_API_KEY is set", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test";
		expect(hasCredentials()).toBe(true);
	});

	it("returns true when Vertex project and region are both set", () => {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
		process.env.CLOUD_ML_REGION = "us-central1";
		expect(hasCredentials()).toBe(true);
	});

	it("returns false when only Vertex project is set without region", () => {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
		expect(hasCredentials()).toBe(false);
	});
});
