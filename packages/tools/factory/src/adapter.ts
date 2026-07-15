import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { alefConfigDir, prototypesDir } from "@dpopsuev/alef-kernel/xdg";
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
		adapters: z
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

/**
 *
 */
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
		adapters: adapterEntries,
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
		"Write a valid TypeScript adapter scaffold to $XDG_DATA_HOME/alef/prototypes/<name>.ts. " +
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

/**
 *
 */
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
		`import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";`,
		`import { withDisplay } from "@dpopsuev/alef-kernel/payload";`,
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

/**
 *
 */
export interface FactoryAdapterOptions {
	cwd?: string;
}

/**
 *
 */
export function createFactoryAdapter(options: FactoryAdapterOptions = {}): Adapter {
	const cwd = options.cwd ?? process.cwd();

	return defineAdapter(
		"factory",
		{
			command: {
				// eslint-disable-next-line @typescript-eslint/require-await
				"factory.adapter": typedAction(ADAPTER_TOOL, async (ctx) => {
					const { name, toolName, description, inputFields } = ctx.payload;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from tool schema
					const fields: Record<string, FieldType> = inputFields as Record<string, FieldType>;

					mkdirSync(prototypesDir(), { recursive: true });
					const targetPath = join(prototypesDir(), `${name}.ts`);
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
				// eslint-disable-next-line @typescript-eslint/require-await
				"factory.blueprint": typedAction(BLUEPRINT_TOOL, async (ctx) => {
					const { name, description, adapters, model, outputPath } = ctx.payload;

					const defaultDir = join(alefConfigDir(), "agents");
					const targetPath = outputPath ? resolve(cwd, outputPath) : join(defaultDir, `${name}.yaml`);

					mkdirSync(dirname(targetPath), { recursive: true });

					const blueprint = buildBlueprint(name, description, adapters, model);
					writeFileSync(targetPath, toYaml(blueprint), "utf-8");

					return withDisplay(
						{
							path: targetPath,
							name,
							adapters,
							next: `orchestration.spawn({ blueprintPath: "${targetPath}" })`,
						},
						{ text: `Blueprint written: ${targetPath}`, mimeType: "text/plain" },
					);
				}),
			},
		},
		{
			description: "Agent factory: scaffold new adapters and write agent blueprints.",
			labels: ["factory", "scaffold", "experimental"],
			directives: [
				"factory.adapter scaffolds a tool under $XDG_DATA_HOME/alef/prototypes then prototype.plug. factory.blueprint writes YAML then spawn. Prefer fs/shell/web/code-intel in adapter lists.",
			],
		},
	);
}
