/**
 * Singular blueprint owner — desired behaviour (RED until collapse lands).
 *
 * Invariant: for a registered stack name, packages/profiles/<stack>/blueprint.yaml
 * is the only adapter list. loadAdapters, materializeDefaultAdapters, and the
 * stack factory must all derive from that file (plus thin cwd overlays).
 *
 * Faulty behaviour today:
 * - registry name → DEFAULT_COMPILED_DEFINITION / empty / CODING_AGENT_BLUEPRINT
 * - profile blueprint.yaml claims SBOM but is not on the parent-tools data path
 * - explore + extraAdapters invent lists in TypeScript
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import {
	CODING_AGENT_BLUEPRINT,
	DEFAULT_COMPILED_DEFINITION,
	materializeDefaultAdapters,
} from "@dpopsuev/alef-blueprint/materializer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdapters } from "../src/boot/adapters.js";
import type { Args } from "../src/boot/args.js";
import type { AlefConfig } from "../src/boot/config.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CODING_BLUEPRINT_YAML = join(REPO_ROOT, "packages/profiles/coding/blueprint.yaml");
const FACTORY_BLUEPRINT_YAML = join(REPO_ROOT, "packages/profiles/factory/blueprint.yaml");
const CODING_STACK_SRC = join(REPO_ROOT, "packages/profiles/coding/src/blueprint.ts");

const log = {
	info: vi.fn(),
	child: () => log,
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

const cfg = {} as AlefConfig;

function baseArgs(cwd: string, overlay: Partial<Args> = {}): Args {
	return {
		cwd,
		print: true,
		json: false,
		noTui: true,
		yolo: false,
		...overlay,
	} as Args;
}

function adapterNamesFromYaml(path: string): string[] {
	return loadAgentDefinition(path).adapters.map((a) => a.name);
}

function sorted(names: readonly string[]): string[] {
	return [...names].sort();
}

describe("singular blueprint owner — coding stack", { tags: ["unit"] }, () => {
	const dirs: string[] = [];
	const canonical = adapterNamesFromYaml(CODING_BLUEPRINT_YAML);

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("profile blueprint.yaml is present and non-empty", () => {
		expect(canonical.length).toBeGreaterThan(0);
		expect(canonical).toContain("fs");
		expect(canonical).toContain("shell");
	});

	it("selecting alef-coding-agent loads adapters from coding blueprint.yaml only", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));
		dirs.push(cwd);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: "alef-coding-agent" }), cfg, log);

		expect(result.blueprintName).toBe("alef-coding-agent");
		expect(sorted(result.adapters.map((a) => a.name))).toEqual(sorted(canonical));
	});

	it("must not substitute a divergent default-blueprint for the coding SBOM", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));
		dirs.push(cwd);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: "alef-coding-agent" }), cfg, log);
		const loaded = sorted(result.adapters.map((a) => a.name));
		const defaultList = sorted(DEFAULT_COMPILED_DEFINITION.adapters.map((a) => a.name));

		expect(loaded).toEqual(sorted(canonical));
		// Singular owner: default list is the coding SBOM (same file / same adapters).
		expect(defaultList).toEqual(sorted(canonical));
	});

	it("materializeDefaultAdapters derives from coding blueprint.yaml", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));
		dirs.push(cwd);

		const adapters = await materializeDefaultAdapters(cwd);
		expect(sorted(adapters.map((a) => a.name))).toEqual(sorted(canonical));
	});

	it("CODING_AGENT_BLUEPRINT must not be a peer list — equal coding YAML or gone", () => {
		const hardcoded = CODING_AGENT_BLUEPRINT.adapters.map((a) => a.name);
		expect(sorted(hardcoded)).toEqual(sorted(canonical));
	});

	it("cwd agent.yaml is an overlay on coding YAML, not a replacement of defaults", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));
		dirs.push(cwd);
		writeFileSync(
			join(cwd, "agent.yaml"),
			`name: project\nadapters:\n  - name: shell\n    blockedPatterns:\n      - "HUSKY=0"\n`,
		);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: "alef-coding-agent" }), cfg, log);
		const names = result.adapters.map((a) => a.name);

		for (const name of canonical) {
			expect(names, `overlay dropped canonical adapter ${name}`).toContain(name);
		}
	});
});

describe("singular blueprint owner — factory stack", { tags: ["unit"] }, () => {
	const dirs: string[] = [];
	const canonical = adapterNamesFromYaml(FACTORY_BLUEPRINT_YAML);

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("selecting alef-factory-agent loads adapters from factory blueprint.yaml only", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));
		dirs.push(cwd);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: "alef-factory-agent" }), cfg, log);

		expect(result.blueprintName).toBe("alef-factory-agent");
		expect(sorted(result.adapters.map((a) => a.name))).toEqual(sorted(canonical));
	});
});

describe("singular blueprint owner — no competing lists", { tags: ["unit"] }, () => {
	it("default-blueprint.yaml is not a silent second coding SBOM", () => {
		const coding = sorted(adapterNamesFromYaml(CODING_BLUEPRINT_YAML));
		const defaults = sorted(DEFAULT_COMPILED_DEFINITION.adapters.map((a) => a.name));
		expect(defaults).toEqual(coding);
	});

	it("profile blueprint.yaml documents itself as the SBOM and must be the runtime source", () => {
		const def = loadAgentDefinition(CODING_BLUEPRINT_YAML);
		expect(def.name).toBe("alef-coding-agent");
		expect(sorted(CODING_AGENT_BLUEPRINT.adapters.map((a) => a.name))).toEqual(
			sorted(def.adapters.map((a) => a.name)),
		);
		expect(sorted(DEFAULT_COMPILED_DEFINITION.adapters.map((a) => a.name))).toEqual(
			sorted(def.adapters.map((a) => a.name)),
		);
	});
});

describe("singular blueprint owner — stack factory must not invent adapters", { tags: ["unit"] }, () => {
	it("coding stack parent adapters are only those named in coding blueprint.yaml", async () => {
		const { createCodingAgentStack } = await import("@dpopsuev/alef-coding-agent");
		const cwd = mkdtempSync(join(tmpdir(), "alef-singular-"));

		try {
			const model = {
				id: "test-model",
				provider: "test",
				api: "test",
				contextWindow: 100_000,
				reasoning: false,
			} as never;

			const stubSessionFactory = () => ({
				state: { id: "eval", modelId: "test-model", contextWindow: 100_000 },
				send: async () => "",
				receive: () => {},
				subscribe: () => () => {},
				dispose: () => {},
				setTurnController: () => {},
			});

			const stack = await createCodingAgentStack({
				cwd,
				model,
				domainAdapters: [],
				subagentFactory: stubSessionFactory as never,
			});

			const canonical = new Set(adapterNamesFromYaml(CODING_BLUEPRINT_YAML));
			const assemblyNames = new Set(["tools", "context.assembly", "compactor"]);
			const parentDomain = stack.adapters.map((a) => a.name).filter((n) => !assemblyNames.has(n));

			for (const name of parentDomain) {
				expect(canonical.has(name), `stack invented adapter "${name}" not in coding blueprint.yaml`).toBe(true);
			}
			for (const name of canonical) {
				expect(parentDomain, `stack missing SBOM adapter "${name}"`).toContain(name);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("explore adapter list must live in blueprint.yaml, not hardcoded in stack TS", () => {
		const src = readFileSync(CODING_STACK_SRC, "utf8");
		expect(src.includes("DEFAULT_EXPLORE_ADAPTERS"), "move explore subset into coding blueprint.yaml").toBe(false);
	});
});
