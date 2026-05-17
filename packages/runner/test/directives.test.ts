import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSystemPrompt, DirectiveContextAssembler } from "../src/directives.js";

const tempDirs: string[] = [];
function tmpCwd(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-dir-"));
	tempDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = "You are a coding assistant.";

// ---------------------------------------------------------------------------
// register + build
// ---------------------------------------------------------------------------

describe("DirectiveContextAssembler.register + build", () => {
	it("returns base prompt when no directives", () => {
		const asm = new DirectiveContextAssembler(BASE);
		expect(asm.build()).toBe(BASE);
	});

	it("appends directive content after base", () => {
		const asm = new DirectiveContextAssembler(BASE);
		asm.register({ id: "d1", layer: "organ", content: "Always read before editing.", weight: 80 });
		const out = asm.build();
		expect(out).toContain(BASE);
		expect(out).toContain("Always read before editing.");
		expect(out).toContain("## Tool Guidance");
	});

	it("deduplicates by id", () => {
		const asm = new DirectiveContextAssembler(BASE);
		asm.register({ id: "d1", layer: "organ", content: "First", weight: 80 });
		asm.register({ id: "d1", layer: "organ", content: "Duplicate", weight: 80 });
		const out = asm.build();
		expect(out).toContain("First");
		expect(out).not.toContain("Duplicate");
	});

	it("higher-weight directive appears before lower-weight", () => {
		const asm = new DirectiveContextAssembler(BASE);
		asm.register({ id: "low", layer: "organ", content: "Low priority guidance.", weight: 60 });
		asm.register({ id: "high", layer: "workspace", content: "High priority rule.", weight: 100 });
		const out = asm.build();
		expect(out.indexOf("High priority rule.")).toBeLessThan(out.indexOf("Low priority guidance."));
	});

	it("respects budgetChars — drops lowest-weight directives first", () => {
		const asm = new DirectiveContextAssembler(BASE);
		asm.register({ id: "keep", layer: "workspace", content: "Keep this.", weight: 100 });
		asm.register({
			id: "drop",
			layer: "global",
			content: "Drop this long directive text that fills budget.",
			weight: 60,
		});
		// Budget: just enough for "Keep this." but not both
		const budget = "Keep this.".length + 10;
		const out = asm.build(budget);
		expect(out).toContain("Keep this.");
		expect(out).not.toContain("Drop this long");
	});
});

// ---------------------------------------------------------------------------
// registerOrgans
// ---------------------------------------------------------------------------

describe("DirectiveContextAssembler.registerOrgans", () => {
	it("collects string directives from organs", () => {
		const fakeOrgan = {
			name: "fs",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			directives: ["Always read before editing.", "Use fs.edit not fs.write for changes."],
			mount: () => () => {},
		};

		const asm = new DirectiveContextAssembler(BASE);
		asm.registerOrgans([fakeOrgan]);
		const out = asm.build();
		expect(out).toContain("Always read before editing.");
		expect(out).toContain("Use fs.edit not fs.write");
	});

	it("skips organs with no directives", () => {
		const silent = { name: "shell", tools: [], subscriptions: { motor: [], sense: [] }, mount: () => () => {} };
		const asm = new DirectiveContextAssembler(BASE);
		asm.registerOrgans([silent]);
		expect(asm.build()).toBe(BASE);
	});
});

// ---------------------------------------------------------------------------
// loadWorkspace
// ---------------------------------------------------------------------------

describe("DirectiveContextAssembler.loadWorkspace", () => {
	it("loads .alef/directives/*.md files", async () => {
		const cwd = tmpCwd();
		mkdirSync(join(cwd, ".alef", "directives"), { recursive: true });
		writeFileSync(join(cwd, ".alef", "directives", "coding.md"), "# Rules\nAlways write tests.");

		const asm = new DirectiveContextAssembler(BASE);
		await asm.loadWorkspace(cwd);
		const out = asm.build();
		expect(out).toContain("Always write tests.");
	});

	it("workspace directives appear before organ directives", async () => {
		const cwd = tmpCwd();
		mkdirSync(join(cwd, ".alef", "directives"), { recursive: true });
		writeFileSync(join(cwd, ".alef", "directives", "rules.md"), "Workspace rule.");

		const organ = {
			name: "fs",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			directives: ["Organ guidance."],
			mount: () => () => {},
		};

		const asm = new DirectiveContextAssembler(BASE);
		await asm.loadWorkspace(cwd);
		asm.registerOrgans([organ]);
		const out = asm.build();
		expect(out.indexOf("Workspace rule.")).toBeLessThan(out.indexOf("Organ guidance."));
	});

	it("silently skips missing .alef/directives directory", async () => {
		const cwd = tmpCwd();
		const asm = new DirectiveContextAssembler(BASE);
		await expect(asm.loadWorkspace(cwd)).resolves.not.toThrow();
		expect(asm.build()).toBe(BASE);
	});

	it("only loads .md files, ignores others", async () => {
		const cwd = tmpCwd();
		mkdirSync(join(cwd, ".alef", "directives"), { recursive: true });
		writeFileSync(join(cwd, ".alef", "directives", "rules.md"), "Valid rule.");
		writeFileSync(join(cwd, ".alef", "directives", "ignore.txt"), "Not a directive.");

		const asm = new DirectiveContextAssembler(BASE);
		await asm.loadWorkspace(cwd);
		const out = asm.build();
		expect(out).toContain("Valid rule.");
		expect(out).not.toContain("Not a directive.");
	});
});

// ---------------------------------------------------------------------------
// assembleSystemPrompt (backward-compat)
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt (backward-compat)", () => {
	it("still works for simple cases", () => {
		const organ = {
			name: "fs",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			directives: ["Read before editing."],
			mount: () => () => {},
		};
		const out = assembleSystemPrompt(BASE, [organ]);
		expect(out).toContain(BASE);
		expect(out).toContain("Read before editing.");
	});
});
