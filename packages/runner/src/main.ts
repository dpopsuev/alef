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
import { createDelegateOrgan } from "@dpopsuev/alef-organ-delegate";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFactoryOrgan } from "@dpopsuev/alef-organ-factory";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import type { Message, ThinkingLevel } from "@dpopsuev/alef-organ-llm";
import {
	Cerebrum,
	createLlmPipeline,
	type TokenUsage,
	type ToolCallEnd,
	type ToolCallStart,
} from "@dpopsuev/alef-organ-llm";
import { createNodeshOrgan } from "@dpopsuev/alef-organ-nodesh";
import { createOrchestrationOrgan } from "@dpopsuev/alef-organ-orchestration";
import { createRouterOrgan } from "@dpopsuev/alef-organ-router";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import { createWebOrgan } from "@dpopsuev/alef-organ-web";
import { ScriptedReasoner, step } from "@dpopsuev/alef-testkit";
import { AgentKernel } from "./agent-kernel.js";
import { DEFAULT_MODEL, parseArgs } from "./args.js";
import { resolveApiKey } from "./auth.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { debugLogPath, initDebugTrace, trace } from "./debug-trace.js";
import type { DirectiveScroll } from "./directive-scroll.js";
import { runInteractive } from "./interactive.js";
import { createLogger, createLoggerForTui } from "./logger.js";
import { DEFAULT_COMPILED_DEFINITION, loadUserOrgansConfig, materializeBlueprint } from "./materializer.js";
import { autoDetectModel, buildModel, detectedProviders, hasCredentials } from "./model.js";
import { createMemoryOrgan } from "./organ-memory.js";
import { setupOTel, shutdownOTel } from "./otel.js";
import { runPrintMode } from "./print-mode.js";
import { createDefaultScroll, loadWorkspace, registerOrgans } from "./prompt.js";
import { SessionGuard } from "./session-guard.js";
import { pickSession } from "./session-picker.js";
import { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { InProcessStrategy } from "./strategies/in-process.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { loadTheme } from "./theme-loader.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "./tool-shell.js";
import { runTuiMode } from "./tui-mode.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// OTel must be registered before any tracer is acquired.
process.title = "alef";
const cfg = loadConfig();
setupOTel();

const args = parseArgs(process.argv.slice(2));

// Handle package manager subcommands before any session/agent setup.
if (
	args.pmInstall ||
	args.pmRemove ||
	args.pmUpgrade ||
	args.pmRollback !== undefined ||
	args.pmHistory ||
	args.pmAudit ||
	args.pmGc ||
	args.pmSearch !== undefined ||
	args.pmSbom ||
	args.pmOrganList ||
	args.pmOrganNew !== undefined ||
	args.pmExport !== undefined ||
	args.pmImport !== undefined
) {
	const pm = await import("./alef-pm.js");
	pm.init();
	if (args.pmInstall) {
		const [name, version] = args.pmInstall.split("@");
		const gen = await pm.install(name, version);
		console.log(`Installed ${args.pmInstall} (generation ${gen})`);
	} else if (args.pmRemove) {
		const gen = await pm.remove(args.pmRemove);
		console.log(`Removed ${args.pmRemove} (generation ${gen})`);
	} else if (args.pmUpgrade) {
		const gen = await pm.upgrade();
		console.log(`Upgraded organs (generation ${gen})`);
	} else if (args.pmRollback !== undefined) {
		const entries = pm.history();
		const target = args.pmRollback === -1 ? (entries[1]?.id ?? 1) : args.pmRollback;
		await pm.rollback(target);
		console.log(`Rolled back to generation ${target}`);
	} else if (args.pmHistory) {
		const entries = pm.history();
		if (entries.length === 0) {
			console.log("No generations recorded.");
		}
		for (const e of entries) {
			const organs =
				Object.entries(e.organs)
					.map(([k, v]) => `${k}@${v}`)
					.join(", ") || "(none)";
			console.log(`  Gen ${e.id}  ${e.ts.slice(0, 19)}  alef=${e.alef}  organs: ${organs}`);
		}
	} else if (args.pmAudit) {
		await pm.audit();
	} else if (args.pmGc) {
		const { removedGenerations, removedStoreEntries } = pm.gc();
		console.log(`GC: removed ${removedGenerations} generations, ${removedStoreEntries} store entries`);
	} else if (args.pmSearch !== undefined) {
		const results = await pm.search(args.pmSearch);
		if (results.length === 0) {
			console.log("No organs found.");
		} else {
			const nameW = Math.max(4, ...results.map((r) => r.name.length));
			const verW = Math.max(7, ...results.map((r) => r.version.length));
			const dlW = 9;
			console.log(`${"NAME".padEnd(nameW)}  ${"VERSION".padEnd(verW)}  ${"DOWNLOADS".padEnd(dlW)}  DESCRIPTION`);
			for (const r of results) {
				const dl = r.downloads.toLocaleString();
				console.log(`${r.name.padEnd(nameW)}  ${r.version.padEnd(verW)}  ${dl.padEnd(dlW)}  ${r.description}`);
			}
		}
	} else if (args.pmSbom) {
		const doc = pm.sbom();
		console.log(JSON.stringify(doc, null, 2));
	} else if (args.pmOrganList) {
		const { loadUserOrgansConfig, userOrgansConfigPath } = await import("./materializer.js");
		const organs = loadUserOrgansConfig();
		if (!organs || organs.length === 0) {
			console.log(`No organs registered in ${userOrgansConfigPath()}`);
		} else {
			console.log(`Organs registered in ${userOrgansConfigPath()}:`);
			for (const o of organs) {
				const detail = o.path ? `  path: ${o.path}` : "";
				console.log(`  ${o.name}${detail}`);
			}
		}
	} else if (args.pmOrganNew !== undefined) {
		if (!args.pmOrganNew.trim()) {
			console.error("Usage: alef organ new <name>");
			process.exit(1);
		}
		const { scaffoldOrgan } = await import("./organ-scaffold.js");
		const dir = scaffoldOrgan(args.pmOrganNew, args.cwd);
		console.log(`Scaffolded organ at ${dir}`);
		console.log(`  cd ${dir}`);
		console.log(`  npm install`);
		console.log(`  npm run build`);
		console.log(`  alef install ./${dir.split("/").pop() ?? ""}`);
	} else if (args.pmExport !== undefined) {
		const outputPath = typeof args.pmExport === "string" ? args.pmExport : undefined;
		const written = pm.exportLockfile(args.cwd, outputPath);
		console.log(`Exported organ lockfile → ${written}`);
		console.log("Commit this file alongside your code for reproducible organ installs.");
	} else if (args.pmImport !== undefined) {
		const inputPath = typeof args.pmImport === "string" ? args.pmImport : undefined;
		const gen = await pm.importLockfile(args.cwd, inputPath);
		console.log(`Restored organs from lockfile (generation ${gen})`);
	}
	process.exit(0);
}

if (args.pmSelfUpdate) {
	const { execSync } = await import("node:child_process");
	const npmCmd = process.env.npm_execpath ? `${process.execPath} "${process.env.npm_execpath}"` : "npm";
	console.log("Upgrading alef to the latest version...");
	try {
		execSync(`${npmCmd} install -g alef-runner@latest`, { stdio: "inherit" });
	} catch {
		console.error("npm install -g alef-runner@latest failed.");
		process.exit(1);
	}
	let globalBin: string;
	try {
		globalBin = `${execSync("npm prefix -g", { encoding: "utf-8" }).trim()}/bin/alef`;
	} catch {
		globalBin = "";
	}
	if (globalBin) {
		console.log(`Upgrade complete. New binary: ${globalBin}`);
	} else {
		console.log("Upgrade complete. Restart alef to use the new version.");
	}
	process.exit(0);
}

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
	// No --blueprint: check ~/.config/alef/organs.yaml (user tier), then fall
	// back to DEFAULT_COMPILED_DEFINITION (fs, shell, nodesh, web).
	const userOrgans = loadUserOrgansConfig();
	const definition = userOrgans ? { ...DEFAULT_COMPILED_DEFINITION, organs: userOrgans } : DEFAULT_COMPILED_DEFINITION;
	if (userOrgans) log.info({ count: userOrgans.length }, "loaded user organs config");
	const defaultMaterialized = await materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
	});
	corpusOrgans = defaultMaterialized.organs;
}

const resolvedModelId = args.modelId ?? blueprintModelId ?? cfg.model;
// Mutable ref — :model colon command updates this so the next send uses the new model.
let currentModel = resolvedModelId ? buildModel(resolvedModelId) : (autoDetectModel() ?? buildModel(DEFAULT_MODEL));
const model = currentModel; // alias for backward-compat with code below that uses `model`
export function setCurrentModel(m: typeof currentModel): void {
	currentModel = m;
}
export function getCurrentModel(): typeof currentModel {
	return currentModel;
}
const resolvedModelDisplay =
	model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// Build the live scroll — rebuilt each turn via prepareStep below.
const currentScrollInstance = createDefaultScroll({
	tools: corpusOrgans.flatMap((o) => o.tools),
	cwd: args.cwd,
});
await loadWorkspace(currentScrollInstance, args.cwd);
registerOrgans(currentScrollInstance, corpusOrgans);
currentScrollInstance.register({
	id: "tool-shell.boot-catalog",
	priority: 900,
	content: buildBootCatalog(corpusOrgans.flatMap((o) => o.tools)),
	enabled: true,
	tags: ["organ", "dynamic"],
});

export let currentScroll: DirectiveScroll = currentScrollInstance;
export function setCurrentScroll(s: DirectiveScroll): void {
	currentScroll = s;
}

function getDirectiveAdapter() {
	return {
		list: () =>
			currentScroll.list({ enabled: undefined }).map((b) => ({
				id: b.id,
				priority: b.priority,
				enabled: b.enabled,
				tags: b.tags,
				contentPreview: (typeof b.content === "function" ? b.content() : b.content).slice(0, 80),
			})),
		enable: (id: string) => {
			currentScroll.enable(id);
		},
		disable: (id: string) => {
			currentScroll.disable(id);
		},
		toggle: (id: string) => {
			currentScroll.toggle(id);
		},
		replace: (id: string, content: string) => {
			currentScroll.replace(id, content);
		},
		add: (id: string, priority: number, content: string, tags?: string[]) => {
			currentScroll.register({ id, priority, content, enabled: true, tags });
		},
		remove: (id: string) => {
			currentScroll.unregister(id);
		},
	};
}

const scrollBudgetChars = Math.floor(model.contextWindow * 0.1 * 4);

// Default to "medium" when the model supports reasoning and no explicit level is set.
// Default to "medium" when the model supports reasoning and no explicit level is set.
// "medium" = adaptive: model decides when to think, skips for simple queries.
// model.reasoning comes from models.generated.ts — the authoritative source.
// Wrapped in an object so the closure mutation in setThinking is visible to biome.
const thinkingState = {
	level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
};

let currentSession: typeof session | undefined = session;
export function setCurrentSession(s: typeof session): void {
	currentSession = s;
}
const prepareStep = (messages: Message[]) => {
	const freshPrompt = currentScroll.build(scrollBudgetChars);
	type Msg = { role: string; content: string };
	return Promise.resolve([
		{ role: "system", content: freshPrompt } as unknown as Message,
		...((messages as Msg[]).filter((m) => m.role !== "system") as unknown as Message[]),
	]);
};
const onCheckpoint = AgentKernel.buildCheckpointCallback(() => currentSession);

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

type SerializedStep =
	| string
	| { kind: "reply"; text: string }
	| { kind: "toolCall"; call: { name: string; args: Record<string, unknown> }; reply: string }
	| { kind: "toolCalls"; calls: Array<{ name: string; args: Record<string, unknown> }>; reply: string };

function deserializeStep(s: SerializedStep): ReturnType<typeof step.reply> {
	if (typeof s === "string") return step.reply(s);
	if (s.kind === "reply") return step.reply(s.text);
	if (s.kind === "toolCall") return step.toolCall(s.call.name, s.call.args, s.reply);
	if (s.kind === "toolCalls") return step.toolCalls(s.calls, s.reply);
	return step.reply(String(s));
}

const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;
const llmOrgan = scriptedRepliesEnv
	? new ScriptedReasoner((JSON.parse(scriptedRepliesEnv) as SerializedStep[]).map(deserializeStep), {
			onToolStart: (e) => toolSlot.onToolStart?.(e),
			onToolEnd: (e) => toolSlot.onToolEnd?.(e),
			onResponseChunk: (chunk) => toolSlot.receiveTextChunk?.(chunk),
		})
	: new Cerebrum({
			model,
			getModel: () => currentModel,
			getApiKey: () => resolveApiKey(currentModel.provider),
			getThinking: () => thinkingState.level,
			maxRetries: cfg.llm?.maxRetries,
			maxRetryDelayMs: cfg.llm?.maxRetryDelayMs,
			timeoutMs: cfg.llm?.timeoutMs,
			prepareStep,
			onCheckpoint,
			trackConcurrentOps: args.serve !== undefined,
			getSignal: () => currentLLMController?.signal,
			phaseTimeoutMs: 100,
			getTools: () => toolShell.currentMetaTools(),
			onToolStart: (event) => toolSlot.onToolStart?.(event),
			onToolEnd: (event) => toolSlot.onToolEnd?.(event),
			onTokenUsage: (usage) => toolSlot.onTokenUsage?.(usage),
			onResponseChunk: (chunk) => toolSlot.receiveTextChunk?.(chunk),
			onThinkingChunk: (chunk) => toolSlot.receiveThinkingChunk?.(chunk),
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

const { agent } = AgentKernel.create({
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
	sessionStore: () => currentSession,
	contextWindow: model.contextWindow,
});
agent.load(memoryOrgan);
agent.load(createLlmPipeline([toolShell.phaseStage(), memoryOrgan.phaseStage()]));
registerOrgans(currentScrollInstance, [toolShell, memoryOrgan]);

// ── Delegation profiles ───────────────────────────────────────────────────
// Build InProcessStrategy profiles and wire organ-delegate.
// organ-delegate holds a mutable strategy registry; orchestration.spawn
// registers RemoteProcessStrategy instances via onChildReady.
const delegateOrgan = createDelegateOrgan({
	strategies: {
		explore: new InProcessStrategy(
			[createFsOrgan({ cwd: args.cwd }), createWebOrgan()],
			currentModel,
			"You are a read-only exploration agent. Read files, search code, fetch URLs. Never write or execute.",
		),
		general: new InProcessStrategy(
			[
				createFsOrgan({ cwd: args.cwd }),
				createShellOrgan({ cwd: args.cwd }),
				createWebOrgan(),
				createNodeshOrgan({ cwd: args.cwd }),
			],
			currentModel,
		),
	},
	cwd: args.cwd,
});

// Wire orchestration.spawn to register child strategies in organ-delegate.
const orchestrationOrgan = createOrchestrationOrgan({
	cwd: args.cwd,
	onChildReady: (name, strategy) => delegateOrgan.registerStrategy(name, strategy),
});

agent.load(delegateOrgan);
agent.load(orchestrationOrgan);
agent.load(createFactoryOrgan({ cwd: args.cwd }));

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

const useTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;

try {
	if (args.print) {
		await runPrintMode(args.prompt, dialog, () => agent.dispose());
	} else if (useTui) {
		// Suppress stderr during TUI — stderr shares the PTY and corrupts the display.
		// Node.js deprecation warnings, library noise, etc. are silently dropped.
		// Callbacks are honoured to satisfy the Node.js stream contract.
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (
			_chunk: string | Uint8Array,
			encOrCb?: BufferEncoding | ((err?: Error | null) => void),
			cb?: (err?: Error | null) => void,
		): boolean => {
			const callback = typeof encOrCb === "function" ? encOrCb : cb;
			callback?.();
			return true;
		};
		try {
			await runTuiMode(
				dialog,
				{
					cwd: args.cwd,
					modelId: resolvedModelDisplay,
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
				},
				() => agent.dispose(),
				setLLMAbortController,
				toolSlot,
				async (_name, path) => {
					const { loadOrganFromPath } = await import("./materializer.js");
					const newOrgan = await loadOrganFromPath(path, {
						cwd: args.cwd,
						loggerFor: (n) => log.child({ organ: n }),
					});
					agent.reload(newOrgan);
				},
				getDirectiveAdapter,
				sessionGuard,
			);
		} finally {
			process.stderr.write = originalStderrWrite;
		}
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
