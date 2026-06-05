import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Organ } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { stringify as toYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const BLUEPRINT_TOOL = {
	name: "factory.blueprint",
	description:
		"Write an agent blueprint YAML. Returns the absolute path — pass it to orchestration.spawn to start the agent.",
	inputSchema: z.object({
		name: z
			.string()
			.regex(/^[a-z][a-z0-9-]*$/, "kebab-case, e.g. lector-agent")
			.describe("Agent name, kebab-case"),
		description: z.string().min(1).describe("One sentence: what this agent does"),
		organs: z
			.array(z.string().min(1))
			.min(1)
			.describe(
				"Organ list. Built-in names: fs, shell, web, nodesh, lector, todos. " +
					"Custom organs: absolute path or path relative to cwd ending in .ts",
			),
		model: z.string().optional().describe("Model override, e.g. claude-haiku-4-5"),
		outputPath: z
			.string()
			.optional()
			.describe("Where to write the blueprint. " + "Default: ~/.config/alef/agents/<name>.yaml"),
	}),
};

const BUILT_IN_ORGANS = new Set([
	"fs",
	"shell",
	"web",
	"nodesh",
	"lector",
	"todos",
	"skills",
	"eval",
	"orchestration",
	"delegate",
	"factory",
]);

function buildBlueprint(name: string, description: string, organs: string[], model?: string): Record<string, unknown> {
	const organEntries = organs.map((organ) => {
		if (BUILT_IN_ORGANS.has(organ)) return { name: organ };
		return { path: organ };
	});

	const spec: Record<string, unknown> = {
		organs: organEntries,
	};
	if (model) spec.model = model;

	return {
		apiVersion: "alef.dpopsuev.io/v1alpha1",
		kind: "AgentRuntime",
		metadata: { name, annotations: { description } },
		spec,
	};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FactoryOrganOptions {
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Organ
// ---------------------------------------------------------------------------

export function createFactoryOrgan(options: FactoryOrganOptions = {}): Organ {
	const cwd = options.cwd ?? process.cwd();

	return defineOrgan(
		"factory",
		{
			"motor/factory.blueprint": typedAction(BLUEPRINT_TOOL, async (ctx) => {
				const { name, description, organs, model, outputPath } = ctx.payload;

				const defaultDir = join(homedir(), ".config", "alef", "agents");
				const targetPath = outputPath ? resolve(cwd, outputPath) : join(defaultDir, `${name}.yaml`);

				mkdirSync(dirname(targetPath), { recursive: true });

				const blueprint = buildBlueprint(name, description, organs, model);
				writeFileSync(targetPath, toYaml(blueprint), "utf-8");

				return withDisplay(
					{
						path: targetPath,
						name,
						organs,
						next: `orchestration.spawn({ blueprintPath: "${targetPath}" })`,
					},
					{ text: `Blueprint written: ${targetPath}`, mimeType: "text/plain" },
				);
			}),
		},
		{
			description: "Agent factory: write agent blueprints and register them for spawning.",
			directives: [
				`**factory.blueprint — create a new agent**

Write a blueprint YAML and get back a path. Then spawn it:

  factory.blueprint({ name, description, organs[], model? })
  → { path, next: "orchestration.spawn({ blueprintPath: ... })" }

Built-in organs you can include:
  fs       — file system (read, write, edit, find, grep, patch)
  shell    — run commands (tests, git, build)
  web      — fetch URLs and search the web
  nodesh   — evaluate JavaScript expressions
  lector   — structural code intelligence (symbols, callers, edit by symbol)
  todos    — task list management
  skills   — load skills from the filesystem

Custom organs:
  Pass an absolute path or a cwd-relative .ts path, e.g. "./organs/reviewer.ts"

Blueprints are saved to ~/.config/alef/agents/<name>.yaml by default.
Pass outputPath to write elsewhere.

Example — create a focused code reviewer:
  factory.blueprint({
    name: "reviewer",
    description: "Reviews code for style and correctness",
    organs: ["fs", "lector"],
    model: "claude-haiku-4-5"
  })
  → orchestration.spawn({ blueprintPath: "~/.config/alef/agents/reviewer.yaml" })`,
			],
		},
	);
}
