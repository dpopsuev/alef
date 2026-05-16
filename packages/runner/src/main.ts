#!/usr/bin/env tsx
/**
 * Alef agent runner.
 *
 * Entry point — parses arguments and dispatches to the correct mode.
 * All business logic lives in the mode files; this file only coordinates.
 */

import { parseArgs } from "./args.js";
import { runInteractive } from "./interactive.js";
import { buildModel, hasCredentials } from "./model.js";
import { runPrintMode } from "./print-mode.js";

const args = parseArgs(process.argv.slice(2));

if (!hasCredentials()) {
	console.warn(
		"Warning: no LLM credentials detected.\n" +
			"Set ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION.\n",
	);
}

const opts = {
	cwd: args.cwd,
	model: buildModel(args.modelId),
};

if (args.print) {
	await runPrintMode(args.prompt, opts);
} else {
	await runInteractive(opts);
}
