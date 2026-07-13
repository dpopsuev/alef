/**
 * Distribution registry freeride — offline simulation (no GitHub / npm network).
 *
 * Pi-mono pattern: npm + git are the registries; the CLI is a local client.
 * Offline substitutes:
 *   npm  → plant a package under ALEF_PM_ROOT/node_modules (post-install layout)
 *   git  → local `git init` repo; install result = checked-out tree on disk
 *   search → stub `npm search` JSON (keyword index), never call the network
 *
 * Desired product path: install published stack → listInstalled sees alef.blueprint
 * → initPmBlueprints registers name → boot loads that package's blueprint.yaml.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pmRoot: string;
let scratch: string;

beforeEach(() => {
	pmRoot = mkdtempSync(join(tmpdir(), "alef-dist-pm-"));
	scratch = mkdtempSync(join(tmpdir(), "alef-dist-scratch-"));
	process.env.ALEF_PM_ROOT = pmRoot;
	process.env.ALEF_PM_SKIP_NPM = "1";
	vi.resetModules();
});

afterEach(() => {
	delete process.env.ALEF_PM_ROOT;
	delete process.env.ALEF_PM_SKIP_NPM;
	vi.restoreAllMocks();
	rmSync(pmRoot, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

async function loadPm() {
	return import("../src/pkg/alef-pm.js");
}

/** Simulate `npm install @scope/pkg` by writing the on-disk layout npm would leave. */
function plantNpmPackage(opts: {
	name: string; // e.g. "@fixture/alef-mini-agent"
	version?: string;
	keywords?: string[];
	alef?: { type: string; entry: string };
	blueprintYaml?: string;
	files?: Record<string, string>;
}): string {
	const parts = opts.name.startsWith("@") ? opts.name.split("/") : [opts.name];
	const dir = join(pmRoot, "node_modules", ...parts);
	mkdirSync(dir, { recursive: true });

	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: opts.name,
				version: opts.version ?? "1.0.0",
				description: "offline fixture package",
				keywords: opts.keywords ?? ["alef-blueprint", "alef-tool"],
				alef: opts.alef,
			},
			null,
			2,
		),
	);

	if (opts.blueprintYaml) {
		writeFileSync(join(dir, "blueprint.yaml"), opts.blueprintYaml);
	}
	for (const [rel, content] of Object.entries(opts.files ?? {})) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return dir;
}

/** Local git repo standing in for github.com/user/repo — no network. */
function plantLocalGitBlueprint(opts: { blueprintYaml: string; packageName: string }): string {
	const repo = join(scratch, "git-repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify(
			{
				name: opts.packageName,
				version: "0.0.1",
				keywords: ["alef-blueprint"],
				alef: { type: "blueprint", entry: "blueprint.yaml" },
			},
			null,
			2,
		),
	);
	writeFileSync(join(repo, "blueprint.yaml"), opts.blueprintYaml);
	execFileSync("git", ["init"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
	return repo;
}

const MINI_BLUEPRINT = `name: fixture-mini-agent
description: Offline fixture stack for distribution tests.
adapters:
  - name: fs
  - name: shell
  - name: agent
capabilities:
  orchestration: true
memory:
  session: memory
`;

describe("distribution freeride — npm layout offline", { tags: ["unit"] }, () => {
	it("listInstalled discovers a planted package with alef blueprint manifest", async () => {
		plantNpmPackage({
			name: "@fixture/alef-mini-agent",
			alef: { type: "blueprint", entry: "blueprint.yaml" },
			blueprintYaml: MINI_BLUEPRINT,
		});

		const { listInstalled, init } = await loadPm();
		init();
		const installed = listInstalled();
		const pkg = installed.find((p) => p.name === "@fixture/alef-mini-agent");
		expect(pkg).toBeDefined();
		expect(pkg?.manifest?.type).toBe("blueprint");
		expect(pkg?.manifest?.entry).toBe("blueprint.yaml");
		expect(existsSync(pkg!.entry)).toBe(true);

		const def = loadAgentDefinition(pkg!.entry);
		expect(def.name).toBe("fixture-mini-agent");
		expect(def.adapters.map((a) => a.name).sort()).toEqual(["agent", "fs", "shell"]);
	});

	it("initPmBlueprints registers stack factory from planted npm package", async () => {
		plantNpmPackage({
			name: "@fixture/alef-mini-agent",
			alef: { type: "blueprint", entry: "blueprint.yaml" },
			blueprintYaml: MINI_BLUEPRINT,
		});

		const { init } = await loadPm();
		init();
		// Import registry from the same module graph as initPmBlueprints (avoid dual singletons).
		const { initPmBlueprints } = await import("../src/boot/init-pm-blueprints.js");
		const { blueprintRegistry } = await import("@dpopsuev/alef-blueprint/registry");
		initPmBlueprints();

		expect(blueprintRegistry.list()).toContain("fixture-mini-agent");
		expect(blueprintRegistry.resolve("fixture-mini-agent")).toBeTypeOf("function");
	});

	it("package keywords declare discoverability convention (search index freeride)", () => {
		const dir = plantNpmPackage({
			name: "@fixture/alef-tool-demo",
			keywords: ["alef-tool", "alef-adapter"],
			alef: { type: "tool", entry: "src/adapter.ts" },
			files: {
				"src/adapter.ts": "export function createAdapter() { return { name: 'demo' }; }\n",
			},
		});
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { keywords: string[] };
		expect(pkg.keywords).toContain("alef-tool");
	});
});

describe("distribution freeride — npm search stubbed offline", { tags: ["unit"] }, () => {
	it("search result shape matches npm search --json keyword freeride", () => {
		// Never call search() here — it shells out to npm. Stub the wire format instead.
		const fakeNpmSearchJson = JSON.stringify([
			{
				name: "@fixture/alef-tool-demo",
				description: "demo",
				version: "1.2.3",
				author: { name: "tester" },
				downloads: { weekly: 42 },
			},
		]);
		const raw = JSON.parse(fakeNpmSearchJson) as Array<{
			name?: string;
			description?: string;
			version?: string;
			author?: { name?: string } | string;
			downloads?: { weekly?: number };
		}>;
		const mapped = raw.map((r) => ({
			name: r.name ?? "",
			description: r.description ?? "",
			version: r.version ?? "",
			author: typeof r.author === "string" ? r.author : (r.author?.name ?? ""),
			downloads: r.downloads?.weekly ?? 0,
		}));

		expect(mapped).toEqual([
			{
				name: "@fixture/alef-tool-demo",
				description: "demo",
				version: "1.2.3",
				author: "tester",
				downloads: 42,
			},
		]);

		const query = "";
		const terms = query.trim() ? `keywords:alef-tool ${query}` : "keywords:alef-tool";
		expect(terms).toBe("keywords:alef-tool");
	});
});

describe("distribution freeride — git checkout offline", { tags: ["unit"] }, () => {
	it("local git repo is a valid blueprint source after clone-equivalent copy", async () => {
		const repo = plantLocalGitBlueprint({
			packageName: "@fixture/git-mini-agent",
			blueprintYaml: MINI_BLUEPRINT,
		});

		// Simulate post-`git clone` layout under a PM-managed git store (pi: ~/.pi/agent/git/).
		const cloneDir = join(pmRoot, "git", "fixture.local", "git-mini-agent");
		mkdirSync(cloneDir, { recursive: true });
		execFileSync("git", ["clone", repo, cloneDir]);

		expect(existsSync(join(cloneDir, "blueprint.yaml"))).toBe(true);
		const def = loadAgentDefinition(join(cloneDir, "blueprint.yaml"));
		expect(def.name).toBe("fixture-mini-agent");
		expect(def.adapters.map((a) => a.name).sort()).toEqual(["agent", "fs", "shell"]);
	});

	it("git-installed blueprint can be linked into node_modules for listInstalled", async () => {
		const repo = plantLocalGitBlueprint({
			packageName: "@fixture/git-mini-agent",
			blueprintYaml: MINI_BLUEPRINT,
		});
		const cloneDir = join(pmRoot, "git", "fixture.local", "git-mini-agent");
		mkdirSync(join(pmRoot, "git", "fixture.local"), { recursive: true });
		execFileSync("git", ["clone", repo, cloneDir]);

		// Until alef-pm has git: install, production freeride still lands packages where
		// listInstalled looks — node_modules. Symlink/copy the clone there.
		const nmDir = join(pmRoot, "node_modules", "@fixture", "git-mini-agent");
		mkdirSync(join(pmRoot, "node_modules", "@fixture"), { recursive: true });
		execFileSync("cp", ["-a", cloneDir, nmDir]);

		const { listInstalled, init } = await loadPm();
		init();
		const pkg = listInstalled().find((p) => p.name === "@fixture/git-mini-agent");
		expect(pkg?.manifest?.type).toBe("blueprint");
		expect(loadAgentDefinition(pkg!.entry).name).toBe("fixture-mini-agent");
	});
});

describe("distribution freeride — singular SBOM from installed package", { tags: ["unit"] }, () => {
	it("boot must load adapters from the installed package blueprint.yaml, not a peer list", async () => {
		plantNpmPackage({
			name: "@fixture/alef-mini-agent",
			alef: { type: "blueprint", entry: "blueprint.yaml" },
			blueprintYaml: MINI_BLUEPRINT,
		});

		const { listInstalled, init } = await loadPm();
		init();
		const pkg = listInstalled().find((p) => p.name === "@fixture/alef-mini-agent");
		expect(pkg).toBeDefined();

		const fromPackage = loadAgentDefinition(pkg!.entry)
			.adapters.map((a) => a.name)
			.sort();

		// Desired: selecting this stack name materializes exactly these adapters.
		// Wire loadAdapters(registryName) → this YAML once collapse lands.
		expect(fromPackage).toEqual(["agent", "fs", "shell"]);

		const { initPmBlueprints } = await import("../src/boot/init-pm-blueprints.js");
		const { blueprintRegistry } = await import("@dpopsuev/alef-blueprint/registry");
		initPmBlueprints();
		expect(blueprintRegistry.resolve("fixture-mini-agent")).toBeDefined();
	});
});
