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
import { EventLogOrgan } from "./event-log-organ.js";
import { runInteractive } from "./interactive.js";
import { createLogger } from "./logger.js";
import { LoopDetectorOrgan } from "./loop-detector.js";
import { materializeBlueprint } from "./materializer.js";
import { buildModel, hasCredentials } from "./model.js";
import { setupOTel, shutdownOTel } from "./otel.js";
import { runPrintMode } from "./print-mode.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { runTuiMode } from "./tui-mode.js";
import { assembleTurns, turnsToMessages } from "./turn-assembler.js";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

// OTel must be registered before any tracer is acquired.
setupOTel();

const args = parseArgs(process.argv.slice(2));
const log = createLogger();

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

if (args.resume) {
	const resumeId = args.resume === "last" ? undefined : args.resume;
	const store = resumeId ? await SessionStore.resume(args.cwd, resumeId) : await SessionStore.resumeLatest(args.cwd);
	if (!store) {
		console.error("No session to resume. Start a new session first.");
		process.exit(1);
	}
	session = store;
	const turnCount = (await session.turns()).length;
	console.error(`[session] Resumed ${session.id} (${turnCount} turns)`);
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
	const materialized = materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
	});
	corpusOrgans = materialized.organs;
	blueprintModelId = materialized.modelId;
} else {
	// Default organ set — mirrors what the runner has always done.
	corpusOrgans = [
		createFsOrgan({ cwd: args.cwd, logger: log.child({ organ: "fs" }) }),
		createShellOrgan({ cwd: args.cwd, logger: log.child({ organ: "shell" }) }),
	];
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
});

const thinkingLevel = args.thinking as import("@dpopsuev/alef-ai").ThinkingLevel | undefined;

// Context window assembly via TurnAssembler (ALE-TSK-179).
// prepareStep is called by LLMOrgan before each turn with the full message array.
// It reads the event log, scores turns by relevance, and returns the budget-fitting subset.
const prepareStep = async (
	messages: import("@dpopsuev/alef-ai").Message[],
): Promise<import("@dpopsuev/alef-ai").Message[]> => {
	const turns = await session.turns();
	const hitCounts = await session.hitCounts();
	// Extract the current user query from the last message for keyword scoring.
	const lastMsg = messages.at(-1);
	const query =
		lastMsg && typeof (lastMsg as { content?: unknown }).content === "string"
			? (lastMsg as { content: string }).content
			: "";
	const selected = assembleTurns(turns, {
		query,
		contextWindow: model.contextWindow,
		hitCounts,
	});
	// Convert to ConversationMessage[], then cast to Message[] (compatible shape).
	const projected = turnsToMessages(selected) as unknown as import("@dpopsuev/alef-ai").Message[];
	// If no history in the log yet, fall back to the original messages from payload.
	return projected.length > 0 ? projected : messages;
};

agent.load(dialog).load(new LLMOrgan({ model, thinking: thinkingLevel, prepareStep }));
for (const organ of corpusOrgans) {
	agent.load(organ);
}
agent.load(new LoopDetectorOrgan({ threshold: args.loopThreshold }));
agent.load(new EventLogOrgan(session));

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

try {
	if (args.print) {
		await runPrintMode(args.prompt, dialog, () => agent.dispose());
	} else if (useTui) {
		await runTuiMode(dialog, { cwd: args.cwd, modelId: resolvedModelId, sessionId: session.id }, () =>
			agent.dispose(),
		);
	} else {
		await runInteractive(dialog, { cwd: args.cwd, modelId: resolvedModelId }, () => agent.dispose());
	}
} finally {
	await shutdownOTel();
}
