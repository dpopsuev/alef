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

import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import { findAgentDefinitionPath, loadAgentDefinition, mergeAgentDefinitions } from "@dpopsuev/alef-agent-blueprint";
import type { ThinkingLevel } from "@dpopsuev/alef-organ-llm";
import { Reasoner, type TokenUsage, type ToolCallEnd, type ToolCallStart } from "@dpopsuev/alef-organ-llm";
import { createRouterOrgan } from "@dpopsuev/alef-organ-router";
import { ScriptedReasoner, step } from "@dpopsuev/alef-testkit";
import { AgentKernel } from "./agent-kernel.js";
import { DEFAULT_MODEL, parseArgs } from "./args.js";
import { resolveApiKey } from "./auth.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { debugLogPath, initDebugTrace, trace } from "./debug-trace.js";
import { DirectiveContextAssembler } from "./directives.js";
import { runInteractive } from "./interactive.js";
import { createLogger, createLoggerForTui } from "./logger.js";
import { DEFAULT_COMPILED_DEFINITION, materializeBlueprint } from "./materializer.js";
import { autoDetectModel, buildModel, detectedProviders, hasCredentials } from "./model.js";
import { setupOTel, shutdownOTel } from "./otel.js";
import { runPrintMode } from "./print-mode.js";
import { buildSystemPrompt } from "./prompt.js";
import { pickSession } from "./session-picker.js";
import { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { loadTheme } from "./theme-loader.js";
import { runTuiMode } from "./tui-mode.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// OTel must be registered before any tracer is acquired.
process.title = "alef";
const cfg = loadConfig();
setupOTel();

const args = parseArgs(process.argv.slice(2));

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
	// In TUI mode with no explicit --resume, offer a session picker when sessions exist.
	const existingSessions = willUseTui ? await SessionStore.list(args.cwd) : [];
	const pickedId = existingSessions.length > 0 ? await pickSession(existingSessions) : undefined;
	if (pickedId) {
		session = await SessionStore.resume(args.cwd, pickedId);
		const turnCount = (await session.turns()).length;
		console.error(`[session] Resumed ${session.id} (${turnCount} turns)`);
	} else {
		session = await SessionStore.create(args.cwd);
		console.error(`[session] ${session.id}`);
	}
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const blueprintPath = args.blueprint ?? findAgentDefinitionPath(args.cwd);

let corpusOrgans = [];
let blueprintModelId: string | undefined;
let blueprintSurfaces: AgentDefinitionSurfaceInput[] = [];
let blueprintUpgradePolicy: "rebuild_only" | "packages" | "self" = "rebuild_only";

if (blueprintPath) {
	let definition = loadAgentDefinition(blueprintPath);

	// Profile overlay: load agent.<profile>.yaml from the same directory and
	// deep-merge it over the base definition (overlay wins on conflicts).
	if (args.profile) {
		const { dirname: pathDirname, join: pathJoin } = await import("node:path");
		const { existsSync: fsExistsSync } = await import("node:fs");
		const baseDir = definition.baseDir ?? pathDirname(blueprintPath);
		const overlayPath = pathJoin(baseDir, `agent.${args.profile}.yaml`);
		if (fsExistsSync(overlayPath)) {
			const overlay = loadAgentDefinition(overlayPath);
			definition = mergeAgentDefinitions(definition, overlay);
		} else {
			console.error(`[alef] Profile overlay not found: ${overlayPath} (continuing without it)`);
		}
	}

	const materialized = await materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
	});
	corpusOrgans = materialized.organs;
	blueprintModelId = materialized.modelId;
	blueprintSurfaces = definition.surfaces;
	blueprintUpgradePolicy = definition.supervisor?.upgradePolicy ?? "rebuild_only";
} else {
	// No --blueprint supplied: use the default organ set through the same
	// materializer path so main.ts stays free of organ imports.
	const defaultMaterialized = await materializeBlueprint(DEFAULT_COMPILED_DEFINITION, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
	});
	corpusOrgans = defaultMaterialized.organs;
}

const resolvedModelId = args.modelId ?? blueprintModelId ?? cfg.model;
const model = resolvedModelId ? buildModel(resolvedModelId) : (autoDetectModel() ?? buildModel(DEFAULT_MODEL));
const resolvedModelDisplay =
	model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const basePrompt = buildSystemPrompt(args.cwd);
const asm = new DirectiveContextAssembler(basePrompt);
await asm.loadWorkspace(args.cwd); // reads .alef/directives/*.md
asm.registerOrgans([...corpusOrgans]); // collects organ.directives strings
const systemPrompt = asm.build(Math.floor(model.contextWindow * 0.1 * 4)); // ~10% of context in chars

const thinkingLevel = (args.thinking ?? cfg.thinking) as ThinkingLevel | undefined;

const prepareStep = AgentKernel.buildContextPrepareStep(session, model.contextWindow);

// In concurrent (HTTP/SSE) mode multiple turns can run simultaneously.
// Reasoner tracks cross-turn in-flight ops and injects pending-operations
// context before each LLM call when trackConcurrentOps=true.
// AbortController for mid-turn cancellation (Ctrl+C while LLM is streaming).
// tui-mode.ts replaces this per-turn via setLLMAbortController.
let currentLLMController: AbortController | undefined;
export function setLLMAbortController(ctrl: AbortController | undefined): void {
	currentLLMController = ctrl;
}

// Mutable callback holder — runTuiMode fills .onToolStart/.onToolEnd
// synchronously during setup, before the first user message arrives.
const toolSlot = {
	onToolStart: undefined as ((event: ToolCallStart) => void) | undefined,
	onToolEnd: undefined as ((event: ToolCallEnd) => void) | undefined,
	onTokenUsage: undefined as ((usage: TokenUsage) => void) | undefined,
	receiveTextChunk: undefined as ((chunk: string) => void) | undefined,
	receiveThinkingChunk: undefined as ((chunk: string) => void) | undefined,
};

const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;
const llmOrgan = scriptedRepliesEnv
	? new ScriptedReasoner((JSON.parse(scriptedRepliesEnv) as string[]).map((text) => step.reply(text)))
	: new Reasoner({
			model,
			getApiKey: () => resolveApiKey(model.provider),
			thinking: thinkingLevel,
			maxRetries: cfg.llm?.maxRetries,
			maxRetryDelayMs: cfg.llm?.maxRetryDelayMs,
			timeoutMs: cfg.llm?.timeoutMs,
			prepareStep,
			trackConcurrentOps: args.serve !== undefined,
			getSignal: () => currentLLMController?.signal,
			onToolStart: (event) => toolSlot.onToolStart?.(event),
			onToolEnd: (event) => toolSlot.onToolEnd?.(event),
			onTokenUsage: (usage) => toolSlot.onTokenUsage?.(usage),
			onResponseChunk: (chunk) => toolSlot.receiveTextChunk?.(chunk),
			onThinkingChunk: (chunk) => toolSlot.receiveThinkingChunk?.(chunk),
		});

// main.ts is always a conversation agent — dialog is always defined.
const { agent, dialog: _dialog } = AgentKernel.create({
	llm: llmOrgan,
	sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
	systemPrompt,
	maxTurns: args.maxTurns,
	session,
	modelId: model.id,
	onLoop: (_type, reason) => {
		process.stderr.write(`\n[loop-detector] ${reason}\n`);
		currentLLMController?.abort(new Error(`[loop-detector] ${reason}`));
	},
});

for (const organ of corpusOrgans) {
	agent.load(organ);
}
// Assert dialog is defined: main.ts is always a conversation agent.
if (!_dialog) throw new Error("AgentKernel did not return a DialogOrgan — main.ts requires one");
const dialog = _dialog;

if (args.serve !== undefined) {
	const sseSurface = blueprintSurfaces.filter((s) => s.type === "sse");
	const allowedEvents = sseSurface.flatMap((s) => s.events ?? []);
	const router = createRouterOrgan({
		port: args.serve,
		allowedEvents,
		onMessage: (text) => dialog.receive(text, "user"),
	});
	agent.load(router);
	await router.ready();
	const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
	console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

agent.validate();
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

if (process.env.ALEF_SUPERVISOR === "1" && typeof process.send === "function") {
	process.on("message", (msg: unknown) => {
		const m = msg as { type?: string; envelope?: { updateId?: string } };
		if (m.type === "handoff_prepare" && m.envelope?.updateId) {
			// Acknowledge the handoff so the supervisor can finalize and promote.
			process.send?.({ type: "handoff_ack", updateId: m.envelope.updateId });
		}
	});

	// Blueprint supervisor policy — upgradePolicy from the blueprint controls
	// which IPC scope is sent when the agent requests a rebuild.
	// rebuild_only → scope 'rebuild'  (build + eval gate, no dep update)
	// packages     → scope 'packages' (npm update + rebuild)
	// self         → scope 'self'     (full stack: verify-and-reexec supervisor)
	const ipcScope =
		blueprintUpgradePolicy === "self" ? "self" : blueprintUpgradePolicy === "packages" ? "packages" : "rebuild";
	console.error(`[alef] supervisor upgrade policy: ${blueprintUpgradePolicy} (scope=${ipcScope})`);

	// Expose globally so organs/tools can trigger a supervisor-managed upgrade.
	(globalThis as Record<string, unknown>).alefRequestRebuild = () => {
		if (ipcScope === "rebuild") {
			process.send?.({ type: "rebuild" });
		} else {
			process.send?.({ type: "update", scope: ipcScope, updateId: crypto.randomUUID() });
		}
	};
}

// SIGINT: Ctrl+C outside raw TUI mode (e.g. during boot or print mode).
process.once("SIGINT", () => {
	process.exit(0);
});

// SIGTERM: finish current turn then exit cleanly.
// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Node.js process.once does not await the handler
process.once("SIGTERM", async () => {
	process.stderr.write("\n[signal] SIGTERM — shutting down cleanly\n");
	try {
		agent.dispose();
		await shutdownOTel();
	} finally {
		process.exit(0);
	}
});

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

const useTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;

try {
	if (args.print) {
		await runPrintMode(args.prompt, dialog, () => agent.dispose());
	} else if (useTui) {
		await runTuiMode(
			dialog,
			{ cwd: args.cwd, modelId: resolvedModelDisplay, sessionId: session.id },
			() => agent.dispose(),
			setLLMAbortController,
			toolSlot,
		);
	} else if (args.serve !== undefined && !process.stdin.isTTY) {
		// --serve without a TTY: RouterOrgan is the sole interface.
		// Block forever — the process stays alive until SIGTERM.
		await new Promise<void>(() => {});
	} else {
		await runInteractive(dialog, { cwd: args.cwd, modelId: resolvedModelDisplay, sessionId: session.id }, () =>
			agent.dispose(),
		);
	}
} finally {
	trace("shutdownOTel:start");
	await Promise.race([shutdownOTel(), new Promise<void>((r) => setTimeout(r, 2000).unref())]);
	trace("shutdownOTel:done");
}

trace("process.exit");
process.exit(0);
