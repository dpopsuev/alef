#!/usr/bin/env tsx
/**
 * Alef agent runner — composition root and entry point.
 *
 * Two wiring modes:
 *
 *   Blueprint mode (--blueprint agent.yaml):
 *     Reads a CompiledAgentDefinition from YAML. The materializer instantiates
 *     organs declared in the blueprint. Model is taken from the blueprint unless
 *     --model or ALEF_MODEL overrides it.
 *
 *   Default mode (no --blueprint):
 *     Hardcoded organ set: FsOrgan + ShellOrgan. Same as before TSK-107.
 *
 * In both modes DialogOrgan and LLMOrgan are always mounted — they are the
 * fixed application core (reasoning + conversation). Only the corpus adapters
 * (fs, shell, web, enclosure, …) are variable.
 */

import { findAgentDefinitionPath, loadAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";

import { DEFAULT_MODEL, parseArgs } from "./args.js";
import { assembleSystemPrompt } from "./directives.js";
import { runInteractive } from "./interactive.js";
import { LoopDetectorOrgan } from "./loop-detector.js";
import { materializeBlueprint } from "./materializer.js";
import { buildModel, hasCredentials } from "./model.js";
import { runPrintMode } from "./print-mode.js";
import { buildSystemPrompt } from "./prompt.js";
import { makeSink } from "./sink.js";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (!hasCredentials()) {
	console.warn(
		"Warning: no LLM credentials detected.\n" +
			"Set ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION.\n",
	);
}

// ---------------------------------------------------------------------------
// Resolve blueprint (if any) and organ set
// ---------------------------------------------------------------------------

// Resolve blueprint path: explicit flag → auto-discover agent.yaml in cwd
const blueprintPath = args.blueprint ?? findAgentDefinitionPath(args.cwd);

let corpusOrgans = [];
let blueprintModelId: string | undefined;

if (blueprintPath) {
	const definition = loadAgentDefinition(blueprintPath);
	const materialized = materializeBlueprint(definition, { cwd: args.cwd });
	corpusOrgans = materialized.organs;
	blueprintModelId = materialized.modelId;
} else {
	// Default organ set — mirrors what the runner has always done.
	corpusOrgans = [createFsOrgan({ cwd: args.cwd }), createShellOrgan({ cwd: args.cwd })];
}

// Model resolution: CLI flag → blueprint → ALEF_MODEL env → DEFAULT_MODEL
const resolvedModelId = args.modelId ?? blueprintModelId ?? DEFAULT_MODEL;
const model = buildModel(resolvedModelId);

// ---------------------------------------------------------------------------
// Compose the agent — the only place organs are wired.
// ---------------------------------------------------------------------------

const agent = new Agent();

// Build system prompt after organs are loaded so directives are available.
const basePrompt = buildSystemPrompt(args.cwd);
const systemPrompt = assembleSystemPrompt(basePrompt, [...corpusOrgans]);

const dialog = new DialogOrgan({
	sink: makeSink(args.json),
	getTools: () => agent.tools,
	systemPrompt,
	maxTurns: args.maxTurns,
});

const thinkingLevel = args.thinking as import("@dpopsuev/alef-ai").ThinkingLevel | undefined;
agent.load(dialog).load(new LLMOrgan({ model, thinking: thinkingLevel }));
for (const organ of corpusOrgans) {
	agent.load(organ);
}
agent.load(new LoopDetectorOrgan({ threshold: args.loopThreshold }));

// ---------------------------------------------------------------------------
// Validate and dispatch
// ---------------------------------------------------------------------------

agent.validate();

if (args.listTools) {
	for (const tool of agent.tools) {
		console.log(tool.name);
	}
	process.exit(0);
}

if (args.print) {
	await runPrintMode(args.prompt, dialog, () => agent.dispose());
} else {
	await runInteractive(dialog, { cwd: args.cwd, modelId: resolvedModelId }, () => agent.dispose());
}
