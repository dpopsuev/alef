import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolShellOrgan } from "@dpopsuev/alef-organ-toolshell";
import { afterEach, describe, expect, it } from "vitest";
import { Directives } from "../src/directives.js";
import { createDefaultDirectives, loadWorkspace, registerOrgans } from "../src/prompt.js";

const tempDirs: string[] = [];
function tmpCwd(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-dir-"));
	tempDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Directives — register, enable, disable, build
// ---------------------------------------------------------------------------

describe("Directives.register + build", { tags: ["unit"] }, () => {
	it("returns empty string when no blocks", () => {
		const d = new Directives();
		expect(d.build()).toBe("");
	});

	it("joins enabled blocks with double newline", () => {
		const d = new Directives();
		d.register({ id: "a", priority: 0, content: "Block A", enabled: true });
		d.register({ id: "b", priority: 1, content: "Block B", enabled: true });
		expect(d.build()).toBe("Block A\n\nBlock B");
	});

	it("omits disabled blocks", () => {
		const d = new Directives();
		d.register({ id: "a", priority: 0, content: "Visible", enabled: true });
		d.register({ id: "b", priority: 1, content: "Hidden", enabled: false });
		expect(d.build()).toContain("Visible");
		expect(d.build()).not.toContain("Hidden");
	});

	it("orders blocks by priority ascending", () => {
		const d = new Directives();
		d.register({ id: "hi", priority: 100, content: "Late", enabled: true });
		d.register({ id: "lo", priority: 0, content: "Early", enabled: true });
		const out = d.build();
		expect(out.indexOf("Early")).toBeLessThan(out.indexOf("Late"));
	});

	it("deduplicates by id — last registration wins", () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "First", enabled: true });
		d.register({ id: "x", priority: 0, content: "Second", enabled: true });
		expect(d.build()).toContain("Second");
		expect(d.build()).not.toContain("First");
	});

	it("resolves function content at build time", () => {
		let value = "initial";
		const d = new Directives();
		d.register({ id: "dynamic", priority: 0, content: () => value, enabled: true });
		expect(d.build()).toBe("initial");
		value = "updated";
		expect(d.build()).toBe("updated");
	});

	it("respects budgetChars — drops lower-priority blocks first", () => {
		const d = new Directives();
		d.register({ id: "keep", priority: 0, content: "Keep.", enabled: true });
		d.register({ id: "drop", priority: 100, content: "Drop this long block.", enabled: true });
		const budget = "Keep.".length + 5;
		const out = d.build(budget);
		expect(out).toContain("Keep.");
		expect(out).not.toContain("Drop");
	});
});

describe("Directives.enable / disable / toggle", { tags: ["unit"] }, () => {
	it("enable makes a disabled block visible", () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Content", enabled: false });
		d.enable("x");
		expect(d.build()).toContain("Content");
	});

	it("disable hides an enabled block", () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Content", enabled: true });
		d.disable("x");
		expect(d.build()).not.toContain("Content");
	});

	it("toggle flips enabled state", () => {
		const d = new Directives();
		d.register({ id: "x", priority: 0, content: "Content", enabled: true });
		d.toggle("x");
		expect(d.build()).not.toContain("Content");
		d.toggle("x");
		expect(d.build()).toContain("Content");
	});
});

describe("Directives.clone / merge / subset / without", { tags: ["unit"] }, () => {
	it("clone produces an independent copy", () => {
		const d = new Directives();
		d.register({ id: "a", priority: 0, content: "Original", enabled: true });
		const clone = d.clone();
		clone.register({ id: "a", priority: 0, content: "Mutated", enabled: true });
		expect(d.build()).toContain("Original");
		expect(clone.build()).toContain("Mutated");
	});

	it("without returns a copy excluding named ids", () => {
		const d = new Directives();
		d.register({ id: "keep", priority: 0, content: "Keep", enabled: true });
		d.register({ id: "drop", priority: 1, content: "Drop", enabled: true });
		const trimmed = d.without("drop");
		expect(trimmed.build()).toContain("Keep");
		expect(trimmed.build()).not.toContain("Drop");
	});
});

// ---------------------------------------------------------------------------
// loadWorkspace
// ---------------------------------------------------------------------------

describe("loadWorkspace", { tags: ["unit"] }, () => {
	it("loads .alef/directives/*.md files into the Directives", async () => {
		const cwd = tmpCwd();
		mkdirSync(join(cwd, ".alef", "directives"), { recursive: true });
		writeFileSync(join(cwd, ".alef", "directives", "rules.md"), "Always write tests.");

		const d = createDefaultDirectives({ tools: [], cwd });
		await loadWorkspace(d, cwd);
		expect(d.build()).toContain("Always write tests.");
	});

	it("only loads .md files, ignores others", async () => {
		const cwd = tmpCwd();
		mkdirSync(join(cwd, ".alef", "directives"), { recursive: true });
		writeFileSync(join(cwd, ".alef", "directives", "rules.md"), "Valid rule.");
		writeFileSync(join(cwd, ".alef", "directives", "ignore.txt"), "Not a directive.");

		const d = createDefaultDirectives({ tools: [], cwd });
		await loadWorkspace(d, cwd);
		expect(d.build()).toContain("Valid rule.");
		expect(d.build()).not.toContain("Not a directive.");
	});

	it("silently skips missing .alef/directives directory", async () => {
		const cwd = tmpCwd();
		const d = createDefaultDirectives({ tools: [], cwd });
		await expect(loadWorkspace(d, cwd)).resolves.not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// registerOrgans
// ---------------------------------------------------------------------------

describe("registerOrgans", { tags: ["unit"] }, () => {
	it("ToolShell directive reaches the built prompt", () => {
		const toolShell = createToolShellOrgan({ tools: [] });
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		registerOrgans(d, [toolShell]);
		expect(d.build()).toContain("tools.describe");
	});

	it("ToolShell extended directive is absent when registerOrgans excludes it", () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		registerOrgans(d, []);
		// BLOCK_GUIDELINES contains a brief tools.describe mention; ToolShell adds the
		// full progressive-disclosure directive. Assert the ToolShell-specific phrase.
		expect(d.build()).not.toContain("Call tools.describe first");
	});

	it("collects string directives from organs", () => {
		const organ = {
			name: "fs",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			sources: [],
			directives: ["Always read before editing."],
			mount: () => () => {},
		};
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		registerOrgans(d, [organ]);
		expect(d.build()).toContain("Always read before editing.");
	});

	it("skips organs with no directives", () => {
		const silent = {
			name: "shell",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			sources: [],
			mount: () => () => {},
		};
		const d = createDefaultDirectives({ tools: [], cwd: "/test" });
		const before = d.build();
		registerOrgans(d, [silent]);
		expect(d.build()).toBe(before);
	});
});
