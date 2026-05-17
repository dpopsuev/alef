/**
 * Blueprint materializer — instantiates Alef EDA organs from a CompiledAgentDefinition.
 *
 * This is the bridge between the declarative YAML blueprint format and the
 * organ instances that Agent.load() accepts. It replaces the hardcoded organ
 * wiring in main.ts when --blueprint is supplied.
 *
 * Blueprint → Organ mapping (EDA names only; legacy organs are skipped):
 *   fs         → createFsOrgan({ cwd, actions })
 *   shell      → createShellOrgan({ cwd, actions })
 *   (ai)       → LLMOrgan — always mounted; blueprint may override model
 *   (discourse) → DialogOrgan — always mounted; not controlled by blueprint
 *   lector     → not yet in EDA; skipped with a console.warn
 *   symbols    → not yet in EDA; skipped with a console.warn
 *   supervisor → not yet in EDA; skipped with a console.warn
 *
 * Model resolution priority:
 *   1. --model CLI flag (already resolved by args.ts before materializer runs)
 *   2. blueprint.model field
 *   3. ALEF_MODEL env var
 *   4. default model (claude-sonnet-4-5)
 */

import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import type { Organ } from "@dpopsuev/alef-spine";

/** Organs that the materializer does not yet support in the EDA runtime. */
const UNSUPPORTED_ORGANS = new Set(["lector", "symbols", "supervisor", "ai", "discourse"]);

export interface MaterializerOptions {
	/** Working directory for FsOrgan and ShellOrgan. */
	cwd: string;
}

export interface MaterializerResult {
	/** Organs to load into Agent, in mount order. */
	organs: Organ[];
	/**
	 * Model ID from the blueprint, if specified and not overridden by CLI.
	 * Format: "provider/model-id" or undefined.
	 */
	modelId: string | undefined;
}

/**
 * Turn a compiled blueprint definition into concrete organ instances.
 * Only organs known to the EDA runtime are instantiated.
 */
export function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): MaterializerResult {
	const organs: Organ[] = [];

	for (const organDef of definition.organs) {
		if (UNSUPPORTED_ORGANS.has(organDef.name)) {
			// ai and discourse are always added by main.ts; lector/symbols/supervisor are roadmap.
			if (organDef.name !== "ai" && organDef.name !== "discourse") {
				console.warn(`[blueprint] Organ '${organDef.name}' is not yet supported in the EDA runtime. Skipping.`);
			}
			continue;
		}

		if (organDef.name === "fs") {
			organs.push(
				createFsOrgan({
					cwd: opts.cwd,
					// Blueprint uses short names (read, write, ...); EDA expects full event types (fs.read, ...).
					actions: organDef.actions.length > 0 ? organDef.actions.map((a) => `fs.${a}`) : undefined,
				}),
			);
			continue;
		}

		if (organDef.name === "shell") {
			organs.push(
				createShellOrgan({
					cwd: opts.cwd,
					// Blueprint uses short names (exec); EDA expects full event types (shell.exec).
					actions: organDef.actions.length > 0 ? organDef.actions.map((a) => `shell.${a}`) : undefined,
				}),
			);
		}
	}

	// Resolve model from blueprint if present.
	let modelId: string | undefined;
	if (definition.model) {
		modelId = `${definition.model.provider}/${definition.model.id}`;
	}

	return { organs, modelId };
}
