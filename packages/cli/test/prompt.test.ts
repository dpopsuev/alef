import { Directives } from "@dpopsuev/alef-agent/directives";
import { BLOCK_CORE, buildPrepareStep, createDefaultDirectives, registerAdapters } from "@dpopsuev/alef-agent/prompt";
import { describe, expect, it } from "vitest";

const FS_TOOLS = [
	{ name: "fs.read", description: "Read a file.", inputSchema: {} as never },
	{ name: "fs.write", description: "Write a file.", inputSchema: {} as never },
	{ name: "fs.edit", description: "Edit a file.", inputSchema: {} as never },
];
const SHELL_TOOLS = [{ name: "shell.exec", description: "Run a shell command.", inputSchema: {} as never }];

/** Build the full system prompt via createDefaultDirectives (replaces deprecated buildSystemPrompt). */
function buildPrompt(tools: typeof FS_TOOLS = []): string {
	return createDefaultDirectives({ tools, cwd: process.cwd() }).build();
}

describe("createDefaultDirectives", { tags: ["unit"] }, () => {
	it("includes active tool names in the tool list", () => {
		const prompt = buildPrompt([...FS_TOOLS, ...SHELL_TOOLS]);
		expect(prompt).toContain("fs.read");
		expect(prompt).toContain("fs.edit");
		expect(prompt).toContain("shell.exec");
	});

	it("shows (no tools loaded) when no tools provided", () => {
		const prompt = buildPrompt();
		expect(prompt).toContain("(no tools loaded)");
	});

	it("includes guidelines block", () => {
		const prompt = buildPrompt(FS_TOOLS);
		expect(prompt).toContain("<guidelines>");
	});

	it("includes date and cwd via the environment block", () => {
		const prompt = buildPrompt();
		const today = new Date().toISOString().split("T")[0];
		expect(prompt).toContain(today);
		expect(prompt).toContain("Directory:");
	});
});

describe("registerAdapters", { tags: ["unit"] }, () => {
	it("includes organ directives in the scroll output", () => {
		const scroll = createDefaultDirectives({ tools: FS_TOOLS, cwd: "/test" });
		const organ = {
			name: "fs",
			tools: FS_TOOLS,
			directives: ["Always read a file before editing it."],
			subscriptions: { command: [] as string[], event: [] as string[], notification: [] as string[] },
			sources: [],
			mount: () => () => {},
		};
		registerAdapters(scroll, [organ]);
		const prompt = scroll.build();
		expect(prompt).toContain("Always read a file before editing it.");
	});

	it("infrastructure organs passed to registerAdapters have their directives in the prompt", () => {
		const scroll = createDefaultDirectives({ tools: [], cwd: "/test" });
		const infraOrgan = {
			name: "tools",
			tools: [] as never[],
			directives: ['Call tools.describe(["tool-name"]) before using any tool.'],
			subscriptions: { command: ["context.assemble"], event: [] as string[], notification: [] as string[] },
			sources: [],
			mount: () => () => {},
		};
		registerAdapters(scroll, [infraOrgan]);
		const prompt = scroll.build();
		expect(prompt).toContain("tools.describe");
	});
});

describe("BLOCK_CORE — consolidated system prompt", { tags: ["unit"] }, () => {
	it("contains identity", () => {
		expect(BLOCK_CORE()).toContain("You are Alef");
	});

	it("contains file creation constraint", () => {
		expect(BLOCK_CORE()).toContain("not create files");
	});

	it("contains no-emoji rule", () => {
		expect(BLOCK_CORE()).toContain("No emojis");
	});

	it("contains git safety rules", () => {
		expect(BLOCK_CORE()).toContain("hooks are mandatory");
		expect(BLOCK_CORE()).toContain("Pre-commit hooks are mandatory");
	});

	it("built prompt contains all core rules in a single block", () => {
		const prompt = buildPrompt();
		expect(prompt).toContain("<core>");
		expect(prompt).toContain("not create files");
		expect(prompt).toContain("No emojis");
		expect(prompt).toContain("hooks are mandatory");
		expect(prompt).toContain("Answer the question first");
	});

	it("core block appears before guidelines in built prompt", () => {
		const scroll = createDefaultDirectives({ tools: [], cwd: "/test" });
		const prompt = scroll.build();
		expect(prompt.indexOf("<core>")).toBeLessThan(prompt.indexOf("<guidelines>"));
	});
});

describe("BLOCK_GUIDELINES — investigation rules", { tags: ["unit"] }, () => {
	it("built prompt contains tool discovery rule", () => {
		const prompt = buildPrompt();
		expect(prompt).toContain("tools.describe");
	});

	it("built prompt contains anti-hallucination rule", () => {
		const prompt = buildPrompt();
		expect(prompt).toContain("Read files before describing them");
	});
});

describe("buildPrepareStep — directives reach the LLM context", { tags: ["unit"] }, () => {
	it("system message content equals directives.build()", async () => {
		const d = new Directives();
		d.register({ id: "rule", priority: 0, content: "No emojis ever.", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hello" }]);
		expect(messages[0]!.role).toBe("system");
		expect(messages[0]!.content).toBe(d.build(100_000));
	});

	it("system message contains registered directive text", async () => {
		const d = new Directives();
		d.register({ id: "core", priority: 0, content: BLOCK_CORE(), enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hi" }]);
		expect(String(messages[0]!.content)).toContain("You are Alef");
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
		expect(String(messages[0]!.content)).toBe("Fresh prompt");
		expect(messages[1]!.role).toBe("user");
	});

	it("system message is always first regardless of input order", async () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "System", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([
			{ role: "user", content: "A" },
			{ role: "assistant", content: "B" },
		]);
		expect(messages[0]!.role).toBe("system");
	});

	it("reflects live directive changes — rebuild on each call", async () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Version 1", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);

		const first = await prepareStep([{ role: "user", content: "?" }]);
		expect(String(first[0]!.content)).toContain("Version 1");

		d.replace("x", "Version 2");
		const second = await prepareStep([{ role: "user", content: "?" }]);
		expect(String(second[0]!.content)).toContain("Version 2");
	});

	it("defaultDirectives includes core rules in the system message", async () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hello" }]);
		const systemContent = String(messages[0]!.content);
		expect(systemContent).toContain("No emojis");
		expect(systemContent).toContain("not create files");
		expect(systemContent).toContain("hooks are mandatory");
	});

	it("organ directive registered via registerAdapters reaches the system message", async () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		const organ = {
			name: "custom",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			directives: ["CUSTOM_DIRECTIVE_SENTINEL"],
			mount: () => () => {},
		};
		registerAdapters(d, [organ]);
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "Hi" }]);
		expect(String(messages[0]!.content)).toContain("CUSTOM_DIRECTIVE_SENTINEL");
	});

	it("disabled directive does not reach the system message", async () => {
		const d = new Directives();
		d.register({ id: "hidden", priority: 0, content: "SECRET_RULE", enabled: false });
		d.register({ id: "visible", priority: 1, content: "PUBLIC_RULE", enabled: true });
		const prepareStep = buildPrepareStep(d, 100_000);
		const messages = await prepareStep([{ role: "user", content: "?" }]);
		const systemContent = String(messages[0]!.content);
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
		const systemContent = String(messages[0]!.content);
		expect(systemContent).toContain("KEEP_THIS");
		expect(systemContent).not.toContain("DROP_THIS");
	});
});
