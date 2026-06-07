import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-kernel";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { CerebrumEvent } from "@dpopsuev/alef-organ-llm";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "@dpopsuev/alef-organ-prompt";
import { createSkillsOrgan } from "@dpopsuev/alef-organ-skills";
import { buildAgent, buildCheckpointCallback } from "../../runner/src/agent-kernel.js";
import { buildDelegation } from "../../runner/src/build-delegation.js";
import { buildLlmOrgan } from "../../runner/src/build-llm-organ.js";
import { loadOrganFromPath, materializeBlueprint } from "../../runner/src/materializer.js";
import { createMemoryOrgan } from "../../runner/src/organ-memory.js";
import type { AgentEvent, Session } from "../../runner/src/session.js";
import type { SessionStore } from "../../runner/src/session-store.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "../../runner/src/tool-shell.js";
import { CODING_AGENT_BLUEPRINT } from "./blueprint.js";

export interface CodingAgentConfig {
	model: Model<Api>;
	cwd: string;
	thinking?: ThinkingLevel;
	onEvent?: (event: CerebrumEvent) => void;
	sessionStore?: () => SessionStore | undefined;
	extraOrgans?: Organ[];
}

export interface CodingAgentSession {
	send(text: string, sender?: string, timeoutMs?: number): Promise<string>;
	subscribe(observer: (event: AgentEvent) => void): () => void;
	readonly tools: readonly ToolDefinition[];
	dispose(): void;
}

export async function createCodingAgent(config: CodingAgentConfig): Promise<CodingAgentSession> {
	const { model, cwd, onEvent, sessionStore, extraOrgans = [] } = config;
	const thinkingState = { level: config.thinking as ThinkingLevel | undefined };

	const directives = createDefaultDirectives({ tools: [], cwd });
	await loadWorkspace(directives, cwd);

	const directivesBudgetChars = Math.floor(model.contextWindow * 0.1 * 4);
	const observers = new Set<(event: AgentEvent) => void>();
	let llmController: AbortController | undefined;
	let reply = "";

	const dialog = new DialogOrgan({
		sink: (t) => {
			if (t) reply = t;
		},
	});

	const dispatch = (event: AgentEvent): void => {
		for (const obs of observers) obs(event);
	};

	const prepareStep = buildPrepareStep(directives, directivesBudgetChars) as unknown as (
		messages: import("@dpopsuev/alef-ai").Message[],
	) => Promise<import("@dpopsuev/alef-ai").Message[]>;
	const onCheckpoint = buildCheckpointCallback(sessionStore);

	const fakeArgs = { cwd, serve: undefined, debug: false } as unknown as Parameters<typeof buildLlmOrgan>[0]["args"];
	const fakeCfg = {} as Parameters<typeof buildLlmOrgan>[0]["cfg"];

	// eslint-disable-next-line prefer-const
	let toolShell!: ReturnType<typeof createToolShellOrgan>;

	const llmOrgan = buildLlmOrgan({
		model,
		cfg: fakeCfg,
		args: fakeArgs,
		onEvent: (e) => {
			dispatch(e as unknown as AgentEvent);
			onEvent?.(e);
		},
		thinkingState,
		prepareStep,
		onCheckpoint,
		getModel: () => model,
		getSignal: () => llmController?.signal,
		getTools: () => toolShell.currentMetaTools(),
		getFullTools: () => agent.tools,
	});

	const { agent } = buildAgent({ dialog, llm: llmOrgan });

	// Load default coding agent organs from blueprint
	const { organs: defaultOrgans } = await materializeBlueprint(CODING_AGENT_BLUEPRINT, { cwd });
	for (const organ of defaultOrgans) agent.load(organ);
	for (const organ of extraOrgans) {
		if (!agent.organs.some((o) => o.name === organ.name)) agent.load(organ);
	}

	if (!agent.organs.some((o) => o.name === "skills")) {
		agent.load(createSkillsOrgan({ cwd }));
	}

	const memoryOrgan = createMemoryOrgan({ sessionStore, contextWindow: model.contextWindow });
	agent.load(memoryOrgan);

	registerOrgans(directives, agent.organs);

	const sessionAdapter: Session = {
		state: { id: "coding-agent", modelId: model.id, contextWindow: model.contextWindow },
		getModel: () => model.id,
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		setTurnController: (c) => {
			llmController = c;
		},
		dispose: () => {},
		receive: (text) => dialog.receive(text, "user"),
		subscribe: (obs) => {
			observers.add(obs as unknown as (event: AgentEvent) => void);
			return () => observers.delete(obs as unknown as (event: AgentEvent) => void);
		},
	};

	const fakeBlueprint = [] as unknown as Parameters<typeof buildDelegation>[4];
	await buildDelegation(fakeArgs, model, agent, sessionAdapter, fakeBlueprint, prepareStep);

	toolShell = createToolShellOrgan({
		tools: agent.tools,
		getTools: () => agent.tools,
		organDirectives: buildOrganDirectives(agent.organs),
	});
	agent.load(toolShell);
	agent.load(createLlmPipeline());
	registerOrgans(directives, [toolShell, memoryOrgan]);

	const alefOrgan = createAlefApiOrgan({
		loadOrgan: (path) => loadOrganFromPath(path, { cwd }),
		agent: {
			load: (o) => agent.load(o),
			unload: (n) => agent.unload(n),
			get organs() {
				return agent.organs;
			},
		},
		cwd,
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

	return {
		async send(text, sender = "human", timeoutMs = 600_000) {
			reply = "";
			await dialog.send(text, sender, timeoutMs);
			return reply;
		},
		subscribe(observer) {
			observers.add(observer);
			return () => observers.delete(observer);
		},
		get tools() {
			return agent.tools;
		},
		dispose() {
			agent.dispose();
		},
	};
}
