/**
 * Bootstrap module: Auto-register YAML blueprints from config directories
 *
 * Bridges the gap between:
 * - YAML discovery (filesystem scanning)
 * - Runtime registry (TypeScript factories)
 *
 * Called at startup before any blueprintRegistry.resolve() calls.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type BlueprintStack,
	type BlueprintStackOptions,
	blueprintRegistry,
	loadAgentDefinition,
	materializeBlueprint,
} from "@dpopsuev/alef-agent-blueprint";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";

/**
 * Scan directories for YAML blueprint files
 */
async function discoverYamlBlueprints(): Promise<string[]> {
	const searchPaths = [
		join(homedir(), ".config/alef/agents"),
		join(homedir(), ".alef/blueprints"),
		join(process.cwd(), ".alef/blueprints"),
	];

	const discovered: string[] = [];

	for (const searchPath of searchPaths) {
		if (!existsSync(searchPath)) continue;

		try {
			// Recursive scan for .yaml files
			const files = await findYamlFiles(searchPath);
			discovered.push(...files);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`Failed to scan ${searchPath}: ${message}`);
		}
	}

	return discovered;
}

/**
 * Recursively find all .yaml files in a directory
 */
async function findYamlFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			// Recurse into subdirectories
			const nested = await findYamlFiles(fullPath);
			results.push(...nested);
		} else if (entry.isFile() && entry.name.endsWith(".yaml")) {
			results.push(fullPath);
		}
	}

	return results;
}

/**
 * Register a YAML blueprint as a runtime factory
 */
function registerYamlBlueprint(yamlPath: string): void {
	try {
		// Load the YAML definition
		const definition = loadAgentDefinition(yamlPath);

		// Extract the blueprint name
		// It's either in resource.metadata.name (envelope format) or definition.name (bare format)
		const name = definition.resource?.metadata?.name || definition.name;
		if (!name) {
			console.warn(`Skipping ${yamlPath}: missing name`);
			return;
		}

		// Create a factory function that wraps the YAML definition
		const factory = async (opts: BlueprintStackOptions): Promise<BlueprintStack> => {
			// Materialize organs from the definition
			const noop = () => {};
			const noopLogger = {
				info: noop,
				warn: noop,
				error: noop,
				debug: noop,
				child: () => noopLogger,
			};

			const { organs } = await materializeBlueprint(definition, {
				cwd: opts.cwd,
				loggerFor: () => noopLogger,
				allowedTools: ["*"],
				writableRoots: opts.writableRoots,
			});

			// Create the context assembly pipeline
			const pipeline = createContextAssemblyPipeline();

			return {
				organs,
				pipeline,
			};
		};

		// Register in the runtime registry
		blueprintRegistry.register(name, factory);

		const description = definition.resource?.metadata?.annotations?.description || `YAML blueprint: ${name}`;
		console.log(`[init-yaml-blueprints] Registered: ${name} - ${description}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`Failed to register ${yamlPath}: ${message}`);
	}
}

/**
 * Initialize YAML blueprint auto-registration
 *
 * Call this at startup before any blueprintRegistry.resolve() calls.
 */
export async function initYamlBlueprints(): Promise<void> {
	const yamlFiles = await discoverYamlBlueprints();

	console.log(`[init-yaml-blueprints] Discovered ${yamlFiles.length} YAML blueprints`);

	for (const yamlPath of yamlFiles) {
		registerYamlBlueprint(yamlPath);
	}

	console.log(`[init-yaml-blueprints] Registry now contains: ${blueprintRegistry.list().join(", ")}`);
}
