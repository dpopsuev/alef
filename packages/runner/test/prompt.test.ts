import { describe, expect, it } from "vitest";
import { Directives } from "../src/directives.js";
import {
	appendEnvironment,
	BLOCK_FORMAT,
	BLOCK_IDENTITY,
	buildPrepareStep,
	buildSystemPrompt,
	createDefaultDirectives,
	registerOrgans,
} from "../src/prompt.js";

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
		const scroll = createDefaultDirectives({ tools: FS_TOOLS, cwd: "/test" });
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
		const scroll = createDefaultDirectives({ tools: [], cwd: "/test" });
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

describe("BLOCK_FORMAT — output discipline rules", () => {
	it("contains no-emoji rule with IMPORTANT marker", () => {
		const format = BLOCK_FORMAT();
		expect(format).toContain("No emojis");
		expect(format).toContain("IMPORTANT");
	});

	it("contains no-filler rule", () => {
		const format = BLOCK_FORMAT();
		expect(format).toContain("No filler");
		expect(format).toContain("Great!");
	});

	it("contains answer-first rule", () => {
		const format = BLOCK_FORMAT();
		expect(format).toContain("Answer the question first");
	});

	it("contains no-preamble rule", () => {
		const format = BLOCK_FORMAT();
		expect(format).toContain("No preamble");
	});

	it("built prompt contains all output discipline rules", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		expect(prompt).toContain("No emojis");
		expect(prompt).toContain("No filler");
		expect(prompt).toContain("No preamble");
		expect(prompt).toContain("Answer the question first");
	});

	it("format block appears before guidelines in built prompt", () => {
		const scroll = createDefaultDirectives({ tools: [], cwd: "/test" });
		const prompt = scroll.build();
		expect(prompt.indexOf("## Format")).toBeLessThan(prompt.indexOf("## Guidelines"));
	});
});

describe("BLOCK_GUIDELINES — investigation rules", () => {
	it("built prompt contains capability-check rule", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		expect(prompt).toContain("tools.describe");
	});

	it("built prompt contains anti-hallucination rule", () => {
		const prompt = buildSystemPrompt({ tools: [] });
		expect(prompt).toContain("Read files before describing them");
	});
});

describe("buildPrepareStep — directives reach the LLM context", () => {
	it("system message content equals directives.build()", async () => {
		const d = new Directives();
		d.register({ id: "rule", priority: 0, content: "No emojis ever.", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hello" }]);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe(d.build(100_000));
	});

	it("system message contains registered directive text", async () => {
		const d = new Directives();
		d.register({ id: "identity", priority: 0, content: BLOCK_IDENTITY(), enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hi" }]);
		expect(String(messages[0].content)).toContain("You are Alef");
	});

	it("strips existing system messages from the input", async () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Fresh prompt", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([
			{ role: "system", content: "Stale system message" },
			{ role: "user", content: "Question" },
		]);
		expect(messages).toHaveLength(2);
		expect(String(messages[0].content)).toBe("Fresh prompt");
		expect(messages[1].role).toBe("user");
	});

	it("system message is always first regardless of input order", async () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "System", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([
			{ role: "user", content: "A" },
			{ role: "assistant", content: "B" },
		]);
		expect(messages[0].role).toBe("system");
	});

	it("reflects live directive changes — rebuild on each call", async () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Version 1", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);

		const first = await prepareStep([{ role: "user", content: "?" }]);
		expect(String(first[0].content)).toContain("Version 1");

		d.replace("x", "Version 2");
		const second = await prepareStep([{ role: "user", content: "?" }]);
		expect(String(second[0].content)).toContain("Version 2");
	});

	it("defaultDirectives includes BLOCK_FORMAT rules in the system message", async () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hello" }]);
		const systemContent = String(messages[0].content);
		expect(systemContent).toContain("No emojis");
		expect(systemContent).toContain("No filler");
		expect(systemContent).toContain("No preamble");
	});

	it("organ directive registered via registerOrgans reaches the system message", async () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		const organ = {
			name: "custom",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			directives: ["CUSTOM_DIRECTIVE_SENTINEL"],
			mount: () => () => {},
		};
		registerOrgans(d, [organ]);
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hi" }]);
		expect(String(messages[0].content)).toContain("CUSTOM_DIRECTIVE_SENTINEL");
	});

	it("disabled directive does not reach the system message", async () => {
		const d = new Directives();
		d.register({ id: "hidden", priority: 0, content: "SECRET_RULE", enabled: false });
		d.register({ id: "visible", priority: 1, content: "PUBLIC_RULE", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "?" }]);
		const systemContent = String(messages[0].content);
		expect(systemContent).toContain("PUBLIC_RULE");
		expect(systemContent).not.toContain("SECRET_RULE");
	});

	it("budget trims lower-priority directives from the system message", async () => {
		const d = new Directives();
		d.register({ id: "keep", priority: 0, content: "KEEP_THIS", enabled: true });
		d.register({ id: "drop", priority: 100, content: "DROP_THIS_LONG_CONTENT_THAT_EXCEEDS_BUDGET", enabled: true });
		const budget = "KEEP_THIS".length + 5;
		const prepareStep = buildPrepareStep(d, budget);
		const messages = await prepareStep([{ role: "user", content: "?" }]);
		const systemContent = String(messages[0].content);
		expect(systemContent).toContain("KEEP_THIS");
		expect(systemContent).not.toContain("DROP_THIS");
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
