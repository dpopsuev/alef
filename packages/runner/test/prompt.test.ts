import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt.js";

describe("buildSystemPrompt", () => {
	it("contains the working directory", () => {
		const prompt = buildSystemPrompt("/home/user/project");
		expect(prompt).toContain("/home/user/project");
	});

	it("contains today's date in ISO format", () => {
		const prompt = buildSystemPrompt("/tmp");
		const today = new Date().toISOString().split("T")[0];
		expect(prompt).toContain(today);
	});

	it("mentions key tools by their sanitised names", () => {
		const prompt = buildSystemPrompt("/tmp");
		expect(prompt).toContain("fs_read");
		expect(prompt).toContain("fs_edit");
		expect(prompt).toContain("shell_exec");
	});

	it("is under 400 tokens (roughly 1600 chars)", () => {
		const prompt = buildSystemPrompt("/some/long/path/to/a/project/directory");
		expect(prompt.length).toBeLessThan(1600);
	});
});
