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
 * In both modes DialogOrgan and Reasoner are always mounted — they are the
 * fixed application core (reasoning + conversation). Only the corpus adapters
 * (fs, shell, web, enclosure, …) are variable.
 */

import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Message, ThinkingLevel } from "@dpopsuev/alef-organ-llm";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import { buildAgent, buildCheckpointCallback } from "./agent-kernel.js";
import { DEFAULT_MODEL, parseArgs } from "./args.js";
import { buildDelegation } from "./build-delegation.js";
import { buildLlmOrgan, type ToolSlot } from "./build-llm-organ.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { debugLogPath, initDebugTrace, trace } from "./debug-trace.js";
import { loadCorpus } from "./load-corpus.js";
import { loadSession } from "./load-session.js";
import { createLogger, createLoggerForTui } from "./logger.js";
import { autoDetectModel, buildModel, detectedProviders, hasCredentials } from "./model.js";
import { createMemoryOrgan } from "./organ-memory.js";
import { setupOTel } from "./otel.js";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "./prompt.js";
import { runAgent } from "./run-agent.js";
import { handleSelfUpdate, runPmCommand } from "./run-pm-command.js";
import { SessionGuard } from "./session-guard.js";
import { setupSupervisorIpc } from "./setup-supervisor-ipc.js";
import { makeSink } from "./sink.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { loadTheme } from "./theme-loader.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "./tool-shell.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// OTel must be registered before any tracer is acquired.
process.title = "alef";
const cfg = loadConfig();
setupOTel();

const args = parseArgs(process.argv.slice(2));

await runPmCommand(args);
await handleSelfUpdate(args);

// Handle debug subcommands before any session/agent setup.
if (args.debugSubcmd) {
	switch (args.debugSubcmd) {
		case "session":
			await runDebugSession(args.debugSubcmdArgs, args.cwd);
			break;
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session");
			process.exit(1);
	}
	process.exit(0);
}

const willUseTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;
const log =
	willUseTui && (args.debug || process.env.ALEF_LOG_LEVEL === "debug")
		? createLoggerForTui(debugLogPath(), args.debug ? "debug" : undefined)
		: createLogger(args.debug ? "debug" : undefined);
initDebugTrace(args.debug);
if (args.debug) process.stderr.write(`[alef] debug log: ${debugLogPath()}\n`);
trace("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui });

if (!hasCredentials()) {
	console.warn(
		"Warning: no LLM credentials detected.\n" +
			"Set an API key env var (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).\n",
	);
} else if (args.debug) {
	process.stderr.write(`[alef] detected providers: ${detectedProviders().join(", ")}\n`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const session = await loadSession(args, willUseTui);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const { corpusOrgans, blueprintModelId, blueprintSurfaces, blueprintUpgradePolicy, blueprintPath } = await loadCorpus(
	args,
	cfg,
	log,
);

const resolvedModelId = args.modelId ?? blueprintModelId ?? cfg.model;
let currentModel = resolvedModelId ? buildModel(resolvedModelId) : (autoDetectModel() ?? buildModel(DEFAULT_MODEL));
const model = currentModel;
const resolvedModelDisplay =
	model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// Build the live scroll — rebuilt each turn via prepareStep below.
const directives = createDefaultDirectives({
	tools: corpusOrgans.flatMap((o) => o.tools),
	cwd: args.cwd,
});
await loadWorkspace(directives, args.cwd);
registerOrgans(directives, corpusOrgans);
directives.register({
	id: "tool-shell.boot-catalog",
	priority: 900,
	content: buildBootCatalog(corpusOrgans.flatMap((o) => o.tools)),
	enabled: true,
	tags: ["organ", "dynamic"],
});

function getDirectiveAdapter() {
	return {
		list: () =>
			directives.list({ enabled: undefined }).map((b) => ({
				id: b.id,
				priority: b.priority,
				enabled: b.enabled,
				tags: b.tags,
				contentPreview: (typeof b.content === "function" ? b.content() : b.content).slice(0, 80),
			})),
		enable: (id: string) => {
			directives.enable(id);
		},
		disable: (id: string) => {
			directives.disable(id);
		},
		toggle: (id: string) => {
			directives.toggle(id);
		},
		replace: (id: string, content: string) => {
			directives.replace(id, content);
		},
		add: (id: string, priority: number, content: string, tags?: string[]) => {
			directives.register({ id, priority, content, enabled: true, tags });
		},
		remove: (id: string) => {
			directives.unregister(id);
		},
	};
}

const directivesBudgetChars = Math.floor(model.contextWindow * 0.1 * 4);

// "medium" = adaptive: model decides when to think, skips for simple queries.
// Wrapped in an object so closure mutation in setThinking is visible to biome.
const thinkingState = {
	level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
};

const prepareStep = buildPrepareStep(directives, directivesBudgetChars) as unknown as (
	messages: Message[],
) => Promise<Message[]>;
const onCheckpoint = buildCheckpointCallback(() => session);

// In concurrent (HTTP/SSE) mode multiple turns can run simultaneously.
// Reasoner tracks cross-turn in-flight ops and injects pending-operations
// context before each LLM call when trackConcurrentOps=true.
// AbortController for mid-turn cancellation (Ctrl+C while LLM is streaming).
// tui-mode.ts replaces this per-turn via setLLMAbortController.
let currentLLMController: AbortController | undefined;
function setLLMAbortController(ctrl: AbortController | undefined): void {
	currentLLMController = ctrl;
}

const toolSlot: ToolSlot = {
	onToolStart: undefined,
	onToolEnd: undefined,
	onTokenUsage: undefined,
	receiveTextChunk: undefined,
	receiveThinkingChunk: undefined,
};

const llmOrgan = buildLlmOrgan({
	model,
	cfg,
	args,
	toolSlot,
	thinkingState,
	prepareStep,
	onCheckpoint,
	getModel: () => currentModel,
	getSignal: () => currentLLMController?.signal,
	getTools: () => toolShell.currentMetaTools(),
});

// ToolShell — progressive disclosure, now always active (ALE-TSK-362 promoted).
// All corpus organs must be in corpusOrgans before this so the snapshot is complete.
const toolShell = createToolShellOrgan({
	tools: corpusOrgans.flatMap((o) => o.tools),
	organDirectives: buildOrganDirectives(corpusOrgans),
});

const dialog = new DialogOrgan({
	sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
});
const sessionGuard = new SessionGuard(dialog, args.maxTurns);

const { agent } = buildAgent({
	dialog,
	llm: llmOrgan,
	session,
	modelId: model.id,
	onLoop: (_type, reason) => {
		trace("loop:detected", { reason });
		currentLLMController?.abort(new Error(`[loop-detector] ${reason}`));
	},
});

for (const organ of corpusOrgans) {
	agent.load(organ);
}
agent.load(toolShell);

const memoryOrgan = createMemoryOrgan({
	sessionStore: () => session,
	contextWindow: model.contextWindow,
});
agent.load(memoryOrgan);
agent.load(createLlmPipeline([toolShell.phaseStage(), memoryOrgan.phaseStage()]));
registerOrgans(directives, [toolShell, memoryOrgan]);

await buildDelegation(args, currentModel, agent, dialog, blueprintSurfaces);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

agent.validate();

if (args.listTools) {
	for (const tool of agent.tools) {
		console.log(tool.name);
	}
	process.exit(0);
}

if (args.listOrgans) {
	for (const organ of agent.organs) {
		const labels = organ.labels?.length ? ` [${organ.labels.join(", ")}]` : "";
		const desc = organ.description ? ` — ${organ.description}` : "";
		console.log(`${organ.name}${labels}${desc}`);
	}
	process.exit(0);
}

await agent.ready();
const opacity = cfg.theme?.background_opacity ?? readAlacrittyOpacity();
const [isDark, terminalPalette] = await Promise.all([
	detectDark(opacity),
	queryPalette(Array.from({ length: 10 }, (_, i) => i + 5)), // slots 5-14
]);
loadTheme(
	blueprintPath ? new URL("..", `file://${blueprintPath}`).pathname : undefined,
	cfg.theme?.name,
	cfg.theme?.colors,
	isDark,
	terminalPalette,
);

setupSupervisorIpc(blueprintUpgradePolicy);

await runAgent({
	agent,
	dialog,
	args,
	resolvedModelDisplay,
	sessionId: session.id,
	contextWindow: model.contextWindow,
	getModel: () => currentModel.id,
	setModel: (id: string) => {
		currentModel = buildModel(id);
		const supportsThinking = currentModel.reasoning && !currentModel.id.includes("haiku");
		if (!supportsThinking) thinkingState.level = undefined;
		else if (!thinkingState.level) thinkingState.level = "medium" as ThinkingLevel;
	},
	getThinking: () => thinkingState.level ?? "off",
	setThinking: (level: string) => {
		thinkingState.level = level === "off" ? undefined : (level as ThinkingLevel);
	},
	setLLMAbortController,
	toolSlot,
	reloadOrgan: async (_name, path) => {
		const { loadOrganFromPath } = await import("./materializer.js");
		const newOrgan = await loadOrganFromPath(path, {
			cwd: args.cwd,
			loggerFor: (n) => log.child({ organ: n }),
		});
		agent.reload(newOrgan);
	},
	getDirectiveAdapter,
	sessionGuard,
});

trace("process.exit");
process.exit(0);
