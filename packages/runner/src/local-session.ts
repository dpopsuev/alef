import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import { createSkillsOrgan } from "@dpopsuev/alef-organ-skills";
import type { Logger } from "pino";
import { buildAgent } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { buildDelegation } from "./build-delegation.js";
import { buildLlmOrgan } from "./build-llm-organ.js";
import type { AlefConfig } from "./config.js";
import type { LoadResult } from "./load-organs.js";
import { loadOrganFromPath } from "./materializer.js";
import { createMemoryOrgan } from "./organ-memory.js";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "./prompt.js";
import type { AgentEvent, Session, SessionState } from "./session.js";
import { SessionHandle } from "./session-handle.js";
import type { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "./tool-shell.js";

export async function createLocalSession(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	store: SessionStore,
	loaded: LoadResult,
	model: Model<Api>,
	trace: (event: string, extra?: Record<string, unknown>) => void,
): Promise<{ session: SessionHandle; resolvedModelDisplay: string }> {
	const { organs, blueprintSurfaces } = loaded;

	const directives = createDefaultDirectives({ tools: organs.flatMap((o) => o.tools), cwd: args.cwd });
	await loadWorkspace(directives, args.cwd);
	registerOrgans(directives, organs);

	if (args.debug) {
		const skillPath = join(homedir(), ".config/opencode/skills/debug-alef/SKILL.md");
		try {
			const skillContent = readFileSync(skillPath, "utf-8");
			directives.register({
				id: "debug-alef-skill",
				priority: 800,
				content: () => skillContent,
				enabled: true,
				tags: ["debug"],
			});
		} catch {
			// Skill file absent — skip silently.
		}
	}

	const directivesBudgetChars = Math.floor(model.contextWindow * 0.1 * 4);
	const thinkingState = {
		level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
	};

	const dialog = new DialogOrgan({
		sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
	});

	const sessionState: SessionState = { id: store.id, modelId: model.id, contextWindow: model.contextWindow };

	const prepareStep = buildPrepareStep(directives, directivesBudgetChars) as unknown as (
		messages: Message[],
	) => Promise<Message[]>;
	const observers = new Set<(event: AgentEvent) => void>();
	let llmController: AbortController | undefined;
	const currentModel = model;

	const dispatch = (event: AgentEvent): void => {
		for (const obs of observers) obs(event);
	};

	// eslint-disable-next-line prefer-const
	let pipeline!: ReturnType<typeof createLlmPipeline>;

	const llmOrgan = buildLlmOrgan({
		model,
		cfg,
		args,
		onEvent: dispatch,
		thinkingState,
		prepareStep,
		getModel: () => currentModel,
		getSignal: () => llmController?.signal,
		schemaResolver: (name) => pipeline?.getSchemaResolver()?.(name),
	});

	const { agent } = buildAgent({
		dialog,
		llm: llmOrgan,
		session: store,
		modelId: model.id,
		onLoop: (_type, reason) => {
			trace("loop:detected", { reason });
			llmController?.abort(new Error(`[loop-detector] ${reason}`));
		},
	});

	for (const organ of organs) agent.load(organ);

	if (!agent.organs.some((o) => o.name === "skills")) {
		agent.load(createSkillsOrgan({ cwd: args.cwd }));
	}

	const memoryOrgan = createMemoryOrgan({ sessionStore: () => store, contextWindow: model.contextWindow });
	agent.load(memoryOrgan);

	const sessionAdapter: Session = {
		state: sessionState,
		getModel: () => model.id,
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		setTurnController: (c: AbortController | undefined) => {
			llmController = c;
		},
		dispose: () => {},
		receive: (text: string) => dialog.receive(text, "user"),
		subscribe: (obs: (event: AgentEvent) => void) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
	};
	await buildDelegation(args, currentModel, agent, sessionAdapter, blueprintSurfaces, prepareStep);

	const toolShell = createToolShellOrgan({
		tools: agent.tools,
		getTools: () => agent.tools,
		organDirectives: buildOrganDirectives(agent.organs),
	});
	agent.load(toolShell);
	pipeline = createLlmPipeline();
	agent.load(pipeline);
	registerOrgans(directives, [toolShell, memoryOrgan]);

	const alefOrgan = createAlefApiOrgan({
		agent: {
			load: (o) => agent.load(o),
			unload: (n) => agent.unload(n),
			get organs() {
				return agent.organs;
			},
		},
		loadOrgan: (path, cwd) => loadOrganFromPath(path, { cwd }),
		cwd: args.cwd,
		dialogEventType: "llm.input",
		onRebuildRequest: () => {
			const trigger = (globalThis as Record<string, unknown>).alefRequestRebuild;
			if (typeof trigger === "function") trigger();
		},
	});
	agent.load(alefOrgan);

	directives.register({
		id: "tool-shell.boot-catalog",
		priority: 900,
		content: () => buildBootCatalog(agent.tools),
		enabled: true,
		tags: ["organ", "dynamic"],
	});

	agent.validate();
	await agent.ready();

	const handle = new SessionHandle({
		state: sessionState,
		model,
		thinkingState,
		dialog,
		agent,
		directives,
		args,
		log,
	});
	for (const obs of observers) handle.subscribe(obs);
	if (llmController) handle.setTurnController(llmController);

	const resolvedModelDisplay =
		model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

	return { session: handle, resolvedModelDisplay };
}
