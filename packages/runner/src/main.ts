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

import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import { findAgentDefinitionPath, loadAgentDefinition, mergeAgentDefinitions } from "@dpopsuev/alef-agent-blueprint";
import type { Message, ThinkingLevel } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { createReactorOrgan } from "@dpopsuev/alef-organ-reactor";
import { createRouterOrgan } from "@dpopsuev/alef-organ-router";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import { ScriptedLLMOrgan, step } from "@dpopsuev/alef-testkit";
import { DEFAULT_MODEL, parseArgs } from "./args.js";
import { DirectiveContextAssembler } from "./directives.js";
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
import { loadTheme } from "./theme-loader.js";
import { runTuiMode } from "./tui-mode.js";
import { assembleTurns, turnsToMessages } from "./turn-assembler.js";

// ---------------------------------------------------------------------------
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

	const materialized = materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
	});
	corpusOrgans = materialized.organs;
	blueprintModelId = materialized.modelId;
	blueprintSurfaces = definition.surfaces;
	blueprintUpgradePolicy = definition.supervisor?.upgradePolicy ?? "rebuild_only";
} else {
	corpusOrgans = [
		createFsOrgan({ cwd: args.cwd, logger: log.child({ organ: "fs" }) }),
		createShellOrgan({ cwd: args.cwd, logger: log.child({ organ: "shell" }) }),
	];
}

const resolvedModelId = args.modelId ?? blueprintModelId ?? DEFAULT_MODEL;
const model = buildModel(resolvedModelId);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const agent = new Agent();

const basePrompt = buildSystemPrompt(args.cwd);
const asm = new DirectiveContextAssembler(basePrompt);
await asm.loadWorkspace(args.cwd); // reads .alef/directives/*.md
asm.registerOrgans([...corpusOrgans]); // collects organ.directives strings
const systemPrompt = asm.build(Math.floor(model.contextWindow * 0.1 * 4)); // ~10% of context in chars

const dialog = new DialogOrgan({
	// TUI mode reads replies via dialog.send() — sink must be silent to avoid double-output.
	sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
	getTools: () => agent.tools,
	systemPrompt,
	maxTurns: args.maxTurns,
});

const thinkingLevel = args.thinking as ThinkingLevel | undefined;

const prepareStep = async (messages: Message[]): Promise<Message[]> => {
	const turns = await session.turns();
	const hitCounts = await session.hitCounts();
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
	const projected = turnsToMessages(selected) as unknown as Message[];
	const src = projected.length > 0 ? "jsonl" : "fallback";
	let result: typeof messages;
	if (projected.length > 0) {
		const currentMsg = messages.at(-1);
		result =
			currentMsg && (currentMsg as { role?: string }).role === "user"
				? ([...projected, currentMsg] as typeof messages)
				: projected;
	} else {
		result = messages;
	}
	// Orange: log prepareStep output so API hangs are diagnosable.
	log.debug(
		{
			src,
			projectedCount: projected.length,
			payloadCount: messages.length,
			resultCount: result.length,
			resultRoles: result.map((m) => (m as { role?: string }).role),
		},
		"prepareStep",
	);
	return result;
};

// ReactorOrgan: tracks in-flight motor events across concurrent turns.
// Provides a chained prepareStep that injects pending-operation context
// into the system message when another turn's tool call is unresolved.
const reactor = createReactorOrgan();
const chainedPrepareStep = async (msgs: Message[]): Promise<Message[]> => {
	const afterTurnAssembler = await prepareStep(msgs);
	return reactor.prepareStep(afterTurnAssembler as { role: string; content: string }[]) as Message[];
};

// AbortController for mid-turn cancellation (Ctrl+C while LLM is streaming).
// tui-mode.ts replaces this per-turn via setLLMAbortController.
let currentLLMController: AbortController | undefined;
export function setLLMAbortController(ctrl: AbortController | undefined): void {
	currentLLMController = ctrl;
}

const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;
const llmOrgan = scriptedRepliesEnv
	? new ScriptedLLMOrgan((JSON.parse(scriptedRepliesEnv) as string[]).map((text) => step.reply(text)))
	: new LLMOrgan({
			model,
			thinking: thinkingLevel,
			prepareStep: chainedPrepareStep,
			getSignal: () => currentLLMController?.signal,
		});
agent.load(dialog).load(llmOrgan).load(reactor);
for (const organ of corpusOrgans) {
	agent.load(organ);
}
agent.load(new LoopDetectorOrgan({ threshold: args.loopThreshold }));
agent.load(new EventLogOrgan(session));

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
loadTheme(blueprintPath ? new URL("..", `file://${blueprintPath}`).pathname : undefined);

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
			{ cwd: args.cwd, modelId: resolvedModelId, sessionId: session.id },
			() => agent.dispose(),
			setLLMAbortController,
		);
	} else if (args.serve !== undefined && !process.stdin.isTTY) {
		// --serve without a TTY: RouterOrgan is the sole interface.
		// Block forever — the process stays alive until SIGTERM.
		await new Promise<void>(() => {});
	} else {
		await runInteractive(dialog, { cwd: args.cwd, modelId: resolvedModelId }, () => agent.dispose());
	}
} finally {
	await shutdownOTel();
}

process.exit(0);
