import { describe, expect, it } from "vitest";
import { appendEnvironment, buildSystemPrompt, createDefaultScroll, registerOrgans } from "../src/prompt.js";

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

	it("includes universal guidelines, not organ-specific guidance", () => {
		const prompt = buildSystemPrompt({ tools: FS_TOOLS });
		expect(prompt).toContain("Guidelines");
		expect(prompt).not.toContain("read a file before editing");
	});

	it("does not embed shell-specific guidance — that lives in organ directives", () => {
		const prompt = buildSystemPrompt({ tools: SHELL_TOOLS });
		expect(prompt).not.toContain("compilation");
	});

	it("includes date and cwd via the environment block", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		const today = new Date().toISOString().split("T")[0];
		expect(prompt).toContain(today);
		expect(prompt).toContain("Directory:");
	});
});

describe("registerOrgans", () => {
	it("includes organ directives in the scroll output", () => {
		const scroll = createDefaultScroll({ tools: FS_TOOLS, cwd: "/test" });
		const organ = {
			name: "fs",
			tools: FS_TOOLS,
			directives: ["Always read a file before editing it."],
			subscriptions: { motor: [] as string[], sense: [] as string[] },
			mount: () => () => {},
		};
		registerOrgans(scroll, [organ]);
		const prompt = scroll.build();
		expect(prompt).toContain("Always read a file before editing it.");
	});

	it("infrastructure organs passed to registerOrgans have their directives in the prompt", () => {
		const scroll = createDefaultScroll({ tools: [], cwd: "/test" });
		const infraOrgan = {
			name: "tools",
			tools: [] as never[],
			directives: ['Call tools.describe(["tool-name"]) before using any tool.'],
			subscriptions: { motor: ["llm.phase"], sense: [] as string[] },
			mount: () => () => {},
		};
		registerOrgans(scroll, [infraOrgan]);
		const prompt = scroll.build();
		expect(prompt).toContain("tools.describe");
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
