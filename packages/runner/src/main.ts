#!/usr/bin/env tsx
/**
 * Alef agent runner — composition root and entry point.
 *
 * This file is the only place that knows about organs.
 * Everything below it (print-mode, interactive) receives only
 * dialog + dispose — they have no organ dependencies.
 *
 * Organ wiring lives here because this IS the composition root.
 * When the blueprint system lands (TSK-107), this wiring moves
 * to a blueprint materializer and this file becomes truly thin.
 */

import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";

import { parseArgs } from "./args.js";
import { runInteractive } from "./interactive.js";
import { buildModel, hasCredentials } from "./model.js";
import { runPrintMode } from "./print-mode.js";

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

const model = buildModel(args.modelId);

// ---------------------------------------------------------------------------
// Compose the agent — the only place organs are imported and wired.
// ---------------------------------------------------------------------------

const agent = new Agent();

const dialog = new DialogOrgan({
	sink: (text) => console.log(text),
	getTools: () => agent.tools,
});

agent
	.load(dialog)
	.load(createFsOrgan({ cwd: args.cwd }))
	.load(createShellOrgan({ cwd: args.cwd }))
	.load(new LLMOrgan({ model }));

// ---------------------------------------------------------------------------
// Dispatch to the correct run mode.
// ---------------------------------------------------------------------------

if (args.print) {
	await runPrintMode(args.prompt, dialog, () => agent.dispose());
} else {
	await runInteractive(dialog, { cwd: args.cwd, modelId: args.modelId }, () => agent.dispose());
}
