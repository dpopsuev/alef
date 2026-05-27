import { describe, expect, it } from "vitest";
import { appendEnvironment, buildSystemPrompt } from "../src/prompt.js";

const FS_TOOLS = [
	{ name: "fs.read", description: "Read a file.", inputSchema: {} as never },
	{ name: "fs.write", description: "Write a file.", inputSchema: {} as never },
	{ name: "fs.edit", description: "Edit a file.", inputSchema: {} as never },
];
const SHELL_TOOLS = [{ name: "shell.exec", description: "Run a shell command.", inputSchema: {} as never }];

describe("buildSystemPrompt", () => {
	it("includes active tool names in the tool list", () => {
		const prompt = buildSystemPrompt({ tools: [...FS_TOOLS, ...SHELL_TOOLS] });
		expect(prompt).toContain("fs.read");
		expect(prompt).toContain("fs.edit");
		expect(prompt).toContain("shell.exec");
	});

	it("shows (no tools loaded) when no tools provided", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		expect(prompt).toContain("(no tools loaded)");
	});

	it("includes fs-conditional guidance when fs tools present", () => {
		const prompt = buildSystemPrompt({ tools: FS_TOOLS });
		expect(prompt).toContain("read a file before editing");
	});

	it("includes shell guidance when shell tool present", () => {
		const prompt = buildSystemPrompt({ tools: SHELL_TOOLS });
		expect(prompt).toContain("shell.exec");
		expect(prompt).toContain("compilation");
	});

	it("does NOT include date or cwd — those are appended separately", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no date
		expect(prompt).not.toContain("Working directory");
	});
});

describe("appendEnvironment", () => {
	it("appends date and cwd last", () => {
		const base = "base prompt";
		const result = appendEnvironment(base, "/my/project");
		expect(result.endsWith("/my/project")).toBe(true);
		const today = new Date().toISOString().split("T")[0];
		expect(result).toContain(today);
		expect(result).toContain("/my/project");
	});

	it("date+cwd appear after all other content", () => {
		const base = buildSystemPrompt({ tools: FS_TOOLS });
		const result = appendEnvironment(base, "/cwd");
		const cwdIdx = result.lastIndexOf("/cwd");
		const guidelinesIdx = result.indexOf("Guidelines");
		expect(cwdIdx).toBeGreaterThan(guidelinesIdx);
	});
});
