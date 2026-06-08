import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-ai";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import type { Directives } from "@dpopsuev/alef-organ-prompt";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "@dpopsuev/alef-organ-prompt";
import { createSkillsOrgan } from "@dpopsuev/alef-organ-skills";
import type { Agent } from "@dpopsuev/alef-runtime";
import type { Logger } from "pino";
import { buildAgent, buildCheckpointCallback } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { buildDelegation } from "./build-delegation.js";
import { buildLlmOrgan } from "./build-llm-organ.js";
import type { AlefConfig } from "./config.js";
import type { CorpusResult } from "./load-corpus.js";
import { loadOrganFromPath } from "./materializer.js";
import { buildModel } from "./model.js";
import { createMemoryOrgan } from "./organ-memory.js";
import type { AgentEvent, DirectiveView, Session, SessionState } from "./session.js";
import type { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "./tool-shell.js";

interface SessionComponents {
	state: SessionState;
	model: Model<Api>;
	thinkingState: { level: ThinkingLevel | undefined };
	dialog: DialogOrgan;
	agent: Agent;
	directives: Directives;
	args: Args;
	log: Logger;
}

export class LocalSession implements Session {
	readonly state: SessionState;

	_currentModel: Model<Api>;
	_thinkingState: { level: ThinkingLevel | undefined };
	_llmController: AbortController | undefined;
	private _turnCount = 0;
	private readonly _observers = new Set<(event: AgentEvent) => void>();

	private readonly _agent: Agent;
	private readonly _directives: Directives;
	private readonly _dialog: DialogOrgan;
	private readonly _args: Args;
	private readonly _log: Logger;

	private constructor({ state, model, thinkingState, dialog, agent, directives, args, log }: SessionComponents) {
		this.state = state;
		this._currentModel = model;
		this._thinkingState = thinkingState;
		this._dialog = dialog;
		this._agent = agent;
		this._directives = directives;
		this._args = args;
		this._log = log;
	}

	static async create(
		args: Args,
		cfg: AlefConfig,
		log: Logger,
		store: SessionStore,
		corpus: CorpusResult,
		model: Model<Api>,
		trace: (event: string, extra?: Record<string, unknown>) => void,
	): Promise<{ session: LocalSession; resolvedModelDisplay: string }> {
		const { corpusOrgans, blueprintSurfaces } = corpus;

		const directives = createDefaultDirectives({ tools: corpusOrgans.flatMap((o) => o.tools), cwd: args.cwd });
		await loadWorkspace(directives, args.cwd);
		registerOrgans(directives, corpusOrgans);

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
			level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as
				| ThinkingLevel
				| undefined,
		};

		const dialog = new DialogOrgan({
			sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
		});

		const sessionState: SessionState = { id: store.id, modelId: model.id, contextWindow: model.contextWindow };

		const prepareStep = buildPrepareStep(directives, directivesBudgetChars) as unknown as (
			messages: Message[],
		) => Promise<Message[]>;
		const onCheckpoint = buildCheckpointCallback(() => store);

		// eslint-disable-next-line prefer-const
		let toolShell!: ReturnType<typeof createToolShellOrgan>;

		// Shared mutable state owned by LocalSession — must be accessible before inst is constructed.
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
			onCheckpoint,
			getModel: () => currentModel,
			getSignal: () => llmController?.signal,
			getTools: () => toolShell.currentMetaTools(),
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

		// Wire validation binding before loading corpus organs so workflow/hitl
		// organs receive a nerve that intercepts validate.required events.
		const hasWorkflow = corpusOrgans.some((o) => o.name === "workflow");
		const hasHitl = corpusOrgans.some((o) => o.name === "hitl");
		if (hasWorkflow && hasHitl) {
			agent.bind({
				id: "workflow.validation",
				event: "validate.required",
				chain: [{ organ: "hitl", timeout: 120_000 }],
				mode: "ordered",
			});
		}

		for (const organ of corpusOrgans) agent.load(organ);

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

		toolShell = createToolShellOrgan({
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

		const inst = new LocalSession({
			state: sessionState,
			model,
			thinkingState,
			dialog,
			agent,
			directives,
			args,
			log,
		});
		for (const obs of observers) inst.subscribe(obs);
		if (llmController) inst.setTurnController(llmController);

		const resolvedModelDisplay =
			model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

		return { session: inst, resolvedModelDisplay };
	}

	getModel(): string {
		return this._currentModel.id;
	}

	setModel(id: string): void {
		this._currentModel = buildModel(id);
		const supportsThinking = this._currentModel.reasoning && !this._currentModel.id.includes("haiku");
		if (!supportsThinking) this._thinkingState.level = undefined;
		else if (!this._thinkingState.level) this._thinkingState.level = "medium" as ThinkingLevel;
	}

	getThinking(): string {
		return this._thinkingState.level ?? "off";
	}

	setThinking(level: string): void {
		this._thinkingState.level = level === "off" ? undefined : (level as ThinkingLevel);
	}

	setTurnController(ctrl: AbortController | undefined): void {
		this._llmController = ctrl;
	}

	async loadOrgan(path: string): Promise<void> {
		const { loadOrganFromPath } = await import("./materializer.js");
		const organ = await loadOrganFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ organ: n }),
		});
		this._agent.load(organ);
	}

	unloadOrgan(name: string): boolean {
		return this._agent.unload(name);
	}

	async reloadOrgan(name: string, path: string): Promise<void> {
		const { loadOrganFromPath } = await import("./materializer.js");
		const organ = await loadOrganFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ organ: n }),
		});
		this._agent.reload({ ...organ, name });
	}

	dispose(): void {
		this._agent.dispose();
	}

	send(text: string, timeoutMs?: number): Promise<string> {
		if (this._args.maxTurns > 0 && this._turnCount >= this._args.maxTurns) {
			return Promise.reject(
				new Error(`Max turns reached (${this._args.maxTurns}). Start a new session to continue.`),
			);
		}
		this._turnCount++;
		return this._dialog.send(text, "human", timeoutMs);
	}

	receive(text: string): void {
		this._dialog.receive(text, "user");
	}

	getDirective(): DirectiveView | undefined {
		const d = this._directives;
		if (!d) return undefined;
		return {
			list: () =>
				d
					.list({ enabled: undefined })
					.map((b) => ({ id: b.id, priority: b.priority, enabled: b.enabled, tags: b.tags })),
			enable: (id) => d.enable(id),
			disable: (id) => d.disable(id),
			toggle: (id) => d.toggle(id),
		};
	}

	subscribe(observer: (event: AgentEvent) => void): () => void {
		this._observers.add(observer);
		return () => {
			this._observers.delete(observer);
		};
	}

	get tools() {
		return this._agent.tools;
	}
	get organs() {
		return this._agent.organs;
	}
}
