import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel/adapter";
import { stringify as toYaml } from "yaml";
import { z } from "zod";

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
				"Adapter list. Built-in names: fs, shell, web, nodesh, lector, todos. " +
					"Custom adapters: absolute path or path relative to cwd ending in .ts",
			),
		model: z.string().optional().describe("Model override, e.g. claude-haiku-4-5"),
		outputPath: z
			.string()
			.optional()
			.describe("Where to write the blueprint. " + "Default: ~/.config/alef/agents/<name>.yaml"),
	}),
};

const BUILT_IN_ADAPTERS = new Set([
	"fs",
	"shell",
	"web",
	"nodesh",
	"code-intel",
	"todos",
	"skills",
	"eval",
	"orchestration",
	"delegate",
	"factory",
]);

function buildBlueprint(
	name: string,
	description: string,
	adapters: string[],
	model?: string,
): Record<string, unknown> {
	const adapterEntries = adapters.map((adapter) => {
		if (BUILT_IN_ADAPTERS.has(adapter)) return { name: adapter };
		return { path: adapter };
	});

	const spec: Record<string, unknown> = {
		organs: adapterEntries,
	};
	if (model) spec.model = model;

	return {
		apiVersion: "alef.dpopsuev.io/v1alpha1",
		kind: "AgentRuntime",
		metadata: { name, annotations: { description } },
		spec,
	};
}

const FIELD_TYPES = ["string", "number", "boolean"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const ADAPTER_TOOL = {
	name: "factory.adapter",
	description:
		"Write a valid TypeScript adapter scaffold to ~/.alef/prototypes/<name>.ts. " +
		"Returns the absolute path — pass it directly to prototype.plug({ path }) to load it.",
	inputSchema: z.object({
		name: z
			.string()
			.regex(/^[a-z][a-z0-9-]*$/, "kebab-case, e.g. weather-client")
			.describe("Adapter name, kebab-case. Used as the filename and defineAdapter namespace."),
		toolName: z
			.string()
			.regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, "namespace.action, e.g. weather.get")
			.describe("Full tool name: namespace.action. The namespace is derived from the text before the first dot."),
		description: z.string().min(1).describe("One sentence: what this tool does."),
		inputFields: z
			.record(z.string().min(1), z.enum(FIELD_TYPES))
			.optional()
			.describe(
				'Map of input field names to types. e.g. { "city": "string", "units": "string" }. ' +
					'Defaults to { input: "string" } if omitted.',
			),
	}),
};

function buildAdapterScaffold(
	_name: string,
	toolName: string,
	description: string,
	inputFields: Record<string, FieldType>,
): string {
	const namespace = toolName.includes(".") ? toolName.slice(0, toolName.indexOf(".")) : toolName;
	const fieldLines = Object.entries(inputFields)
		.map(([key, type]) => `\t\t\t${key}: z.${type}().describe(""),`)
		.join("\n");
	const fieldNames = Object.keys(inputFields).join(", ");
	const descLower = description.endsWith(".") ? description.slice(0, -1).toLowerCase() : description.toLowerCase();

	return [
		`import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";`,
		`import { z } from "zod";`,
		``,
		`export function createAdapter() {`,
		`\tconst TOOL = {`,
		`\t\tname: "${toolName}",`,
		`\t\tdescription: "${description}",`,
		`\t\tinputSchema: z.object({`,
		fieldLines,
		`\t\t}),`,
		`\t};`,
		``,
		`\treturn defineAdapter("${namespace}", {`,
		`\t\tcommand: {`,
		`\t\t\t"${toolName}": typedAction(TOOL, async (ctx) => {`,
		`\t\t\t\tconst { ${fieldNames} } = ctx.payload;`,
		`\t\t\t\t// TODO: implement`,
		`\t\t\t\treturn withDisplay(`,
		`\t\t\t\t\t{ ${fieldNames} },`,
		`\t\t\t\t\t{ text: \`${toolName}: not yet implemented\`, mimeType: "text/plain" },`,
		`\t\t\t\t);`,
		`\t\t\t}),`,
		`\t\t},`,
		`\t}, {`,
		`\t\tdescription: "${description}",`,
		`\t\tdirectives: ["Use ${toolName} to ${descLower}."],`,
		`\t});`,
		`}`,
		``,
	].join("\n");
}

const PROTOTYPES_DIR = join(homedir(), ".alef", "prototypes");

export interface FactoryAdapterOptions {
	cwd?: string;
}

/** @deprecated Use FactoryAdapterOptions */
export type FactoryOrganOptions = FactoryAdapterOptions;

export function createFactoryOrgan(options: FactoryAdapterOptions = {}): Adapter {
	const cwd = options.cwd ?? process.cwd();

	return defineAdapter(
		"factory",
		{
			command: {
				"factory.adapter": typedAction(ADAPTER_TOOL, async (ctx) => {
					const { name, toolName, description, inputFields } = ctx.payload;
					const fields: Record<string, FieldType> = (inputFields as Record<string, FieldType>) ?? {
						input: "string",
					};

					mkdirSync(PROTOTYPES_DIR, { recursive: true });
					const targetPath = join(PROTOTYPES_DIR, `${name}.ts`);
					const scaffold = buildAdapterScaffold(name, toolName, description, fields);
					writeFileSync(targetPath, scaffold, "utf-8");

					return withDisplay(
						{
							path: targetPath,
							name,
							toolName,
							next: `prototype.plug({ path: "${targetPath}" })`,
						},
						{ text: `Adapter scaffold written: ${targetPath}`, mimeType: "text/plain" },
					);
				}),
				"factory.blueprint": typedAction(BLUEPRINT_TOOL, async (ctx) => {
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
		},
		{
			description: "Agent factory: scaffold new adapters and write agent blueprints.",
			directives: [
				`**factory.adapter — scaffold a new adapter**

Write a valid TypeScript adapter to ~/.alef/prototypes/<name>.ts, then load it:

  factory.adapter({ name, toolName, description, inputFields? })
  → { path, next: "prototype.plug({ path })" }

inputFields is a map of field name to type: { "city": "string", "units": "string" }.
Defaults to { input: "string" } if omitted. Edit the file after loading to add logic.

**factory.blueprint — create a new agent**

Write a blueprint YAML and get back a path. Then spawn it:

  factory.blueprint({ name, description, organs[], model? })
  → { path, next: "orchestration.spawn({ blueprintPath: ... })" }

Built-in adapters you can include:
  fs       — file system (read, write, edit, find, grep, patch)
  shell    — run commands (tests, git, build)
  web      — fetch URLs and search the web
  nodesh   — evaluate JavaScript expressions
  lector   — structural code intelligence (symbols, callers, edit by symbol)
  todos    — task list management
  skills   — load skills from the filesystem

Custom adapters:
  Pass an absolute path or a cwd-relative .ts path, e.g. "./adapters/reviewer.ts"

Blueprints are saved to ~/.config/alef/agents/<name>.yaml by default.
Pass outputPath to write elsewhere.

Example — create a focused code reviewer:
  factory.blueprint({
    name: "reviewer",
    description: "Reviews code for style and correctness",
    organs: ["fs", "code-intel"],
    model: "claude-haiku-4-5"
  })
  → orchestration.spawn({ blueprintPath: "~/.config/alef/agents/reviewer.yaml" })`,
			],
		},
	);
}
