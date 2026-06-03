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
 *     Hardcoded organ set: FsOrgan + ShellOrgan.
 *
 * In both modes DialogOrgan and Reasoner are always mounted — they are the
 * fixed application core (reasoning + conversation). Only the corpus adapters
 * (fs, shell, web, enclosure, …) are variable.
 */

import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Message, ThinkingLevel } from "@dpopsuev/alef-organ-llm";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import { buildAgent, buildCheckpointCallback } from "./agent-kernel.js";
import { parseArgs } from "./args.js";
import { buildDelegation } from "./build-delegation.js";
import { buildLlmOrgan, type ToolSlot } from "./build-llm-organ.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { setupTrace } from "./debug-trace.js";
import { loadCorpus } from "./load-corpus.js";
import { loadSession } from "./load-session.js";
import { createRunnerLogger } from "./logger.js";
import { buildModel, resolveStartupModel } from "./model.js";
import { createMemoryOrgan } from "./organ-memory.js";
import { setupOTel } from "./otel.js";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "./prompt.js";
import { runAgent } from "./run-agent.js";
import { handleSelfUpdate, runPmCommand } from "./run-pm-command.js";
import type { AgentEvent, Session } from "./session.js";

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
const log = createRunnerLogger(willUseTui, args.debug);
const trace = setupTrace(args.debug);
trace("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui });

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

let currentModel = resolveStartupModel(args, blueprintModelId, cfg);
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

// ToolShell — progressive disclosure, now always active.
// All corpus organs must be in corpusOrgans before this so the snapshot is complete.
const toolShell = createToolShellOrgan({
	tools: corpusOrgans.flatMap((o) => o.tools),
	organDirectives: buildOrganDirectives(corpusOrgans),
});

const dialog = new DialogOrgan({
	sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
});
let _turnCount = 0;

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

// ---------------------------------------------------------------------------
// LocalSession — Strategy implementation for an in-process agent.
// Owned by main.ts; threaded into runAgent so the TUI never touches
// DialogOrgan, SessionGuard, ToolSlot, or AbortController directly.
// ---------------------------------------------------------------------------

const _sessionObservers = new Set<(event: AgentEvent) => void>();
const _dispatch = (event: AgentEvent): void => {
	for (const observer of _sessionObservers) observer(event);
};

toolSlot.onToolStart = (e) => _dispatch({ type: "tool-start", callId: e.callId, name: e.name, args: e.args });
toolSlot.onToolEnd = (e) =>
	_dispatch({
		type: "tool-end",
		callId: e.callId,
		elapsedMs: e.elapsedMs,
		ok: e.ok,
		display: e.display,
		displayKind: e.displayKind,
	});
toolSlot.onTokenUsage = (u) =>
	_dispatch({ type: "token-usage", usage: { input: u.input, output: u.output, totalTokens: u.totalTokens } });
toolSlot.receiveTextChunk = (chunk) => _dispatch({ type: "chunk", text: chunk });
toolSlot.receiveThinkingChunk = (chunk) => _dispatch({ type: "thinking", text: chunk });

const localOrganLoader = async (path: string) => {
	const { loadOrganFromPath } = await import("./materializer.js");
	return loadOrganFromPath(path, { cwd: args.cwd, loggerFor: (n) => log.child({ organ: n }) });
};

const localSession: Session = {
	state: { id: session.id, modelId: model.id, contextWindow: model.contextWindow },
	getModel: () => currentModel.id,
	setModel: (id) => {
		currentModel = buildModel(id);
		const supportsThinking = currentModel.reasoning && !currentModel.id.includes("haiku");
		if (!supportsThinking) thinkingState.level = undefined;
		else if (!thinkingState.level) thinkingState.level = "medium" as ThinkingLevel;
	},
	getThinking: () => thinkingState.level ?? "off",
	setThinking: (level) => {
		thinkingState.level = level === "off" ? undefined : (level as ThinkingLevel);
	},
	setTurnController: (ctrl) => {
		currentLLMController = ctrl;
	},
	loadOrgan: async (path) => {
		agent.load(await localOrganLoader(path));
	},
	unloadOrgan: (name) => agent.unload(name),
	reloadOrgan: async (name, path) => {
		const organ = await localOrganLoader(path);
		agent.reload({ ...organ, name });
	},
	dispose: () => agent.dispose(),
	send: (text, timeoutMs) => {
		if (args.maxTurns > 0 && _turnCount >= args.maxTurns) {
			return Promise.reject(new Error(`Max turns reached (${args.maxTurns}). Start a new session to continue.`));
		}
		_turnCount++;
		return dialog.send(text, "human", timeoutMs);
	},
	receive: (text) => dialog.receive(text, "user"),
	getDirective: getDirectiveAdapter,
	subscribe: (observer) => {
		_sessionObservers.add(observer);
		return () => {
			_sessionObservers.delete(observer);
		};
	},
};

await buildDelegation(args, currentModel, agent, localSession, blueprintSurfaces);

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
	session: localSession,
});

trace("process.exit");
process.exit(0);
