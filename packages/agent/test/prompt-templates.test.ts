import { listPromptTemplates, loadPrompt } from "@dpopsuev/alef-agent/prompt-templates";
import { describe, expect, it } from "vitest";

describe("prompt templates", { tags: ["unit"] }, () => {
	it("loads identity template", () => {
		const text = loadPrompt("identity");
		expect(text).toContain("Alef");
		expect(text).toContain("coding agent");
	});

	it("loads no-emojis template", () => {
		const text = loadPrompt("no-emojis");
		expect(text).toContain("No emojis");
	});

	it("loads no-files template", () => {
		const text = loadPrompt("no-files");
		expect(text).toContain("Never create files");
	});

	it("lists available templates", () => {
		const templates = listPromptTemplates();
		expect(templates).toContain("identity");
		expect(templates).toContain("no-emojis");
		expect(templates).toContain("no-files");
	});

	it("substitutes variables", () => {
		const text = loadPrompt("identity");
		expect(text).toBeTruthy();
	});

	it("caches loaded templates", () => {
		const a = loadPrompt("identity");
		const b = loadPrompt("identity");
		expect(a).toBe(b);
	});

	it("throws for missing template", () => {
		expect(() => loadPrompt("nonexistent")).toThrow();
	});
});
