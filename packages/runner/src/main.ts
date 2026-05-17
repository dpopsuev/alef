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
import { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { runTuiMode } from "./tui-mode.js";

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
// Session: list or resume
// ---------------------------------------------------------------------------

if (args.listSessions) {
	const sessions = await SessionStore.list(args.cwd);
	if (sessions.length === 0) {
		console.log("No sessions for", args.cwd);
	} else {
		for (const s of sessions) {
			console.log(`${s.id}  ${s.mtime.toISOString().replace("T", " ").slice(0, 16)}  ${s.path}`);
		}
	}
	process.exit(0);
}

let session: SessionStore;
let initialHistory: Array<{ role: "user" | "assistant"; content: string }> | undefined;

if (args.resume) {
	const resumeId = args.resume === "last" ? undefined : args.resume;
	const store = resumeId ? await SessionStore.resume(args.cwd, resumeId) : await SessionStore.resumeLatest(args.cwd);
	if (!store) {
		console.error("No session to resume. Start a new session first.");
		process.exit(1);
	}
	session = store;
	const msgs = await session.messages();
	initialHistory = msgs.map((m) => ({ role: m.role, content: m.content }));
	console.error(`[session] Resumed ${session.id} (${msgs.length} messages)`);
} else {
	session = await SessionStore.create(args.cwd);
	console.error(`[session] ${session.id}`);
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
	// TUI mode reads replies via dialog.send() — sink must be silent to avoid double-output.
	sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
	getTools: () => agent.tools,
	systemPrompt,
	maxTurns: args.maxTurns,
	initialHistory,
	onMessage: (msg) => {
		void session.append({ role: msg.role as "user" | "assistant", content: msg.content, timestamp: Date.now() });
	},
});

const thinkingLevel = args.thinking as import("@dpopsuev/alef-ai").ThinkingLevel | undefined;
agent.load(dialog).load(
	new LLMOrgan({
		model,
		thinking: thinkingLevel,
		onCompact: (summary) => {
			process.stderr.write(`\n[compaction] Context summarised (${summary.length} chars).\n`);
		},
	}),
);
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

const useTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;

if (args.print) {
	await runPrintMode(args.prompt, dialog, () => agent.dispose());
} else if (useTui) {
	await runTuiMode(dialog, { cwd: args.cwd, modelId: resolvedModelId, sessionId: session.id }, () => agent.dispose());
} else {
	await runInteractive(dialog, { cwd: args.cwd, modelId: resolvedModelId }, () => agent.dispose());
}
