import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-organ-llm";
import { createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import type { Directives } from "@dpopsuev/alef-organ-prompt";
import { buildPrepareStep, createDefaultDirectives, loadWorkspace, registerOrgans } from "@dpopsuev/alef-organ-prompt";
import type { Logger } from "pino";
import { buildAgent, buildCheckpointCallback } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { buildDelegation } from "./build-delegation.js";
import { buildLlmOrgan } from "./build-llm-organ.js";
import type { AlefConfig } from "./config.js";
import type { CorpusResult } from "./load-corpus.js";
import { buildModel } from "./model.js";
import { createMemoryOrgan } from "./organ-memory.js";
import type { AgentEvent, DirectiveView, Session, SessionState } from "./session.js";
import type { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "./tool-shell.js";

export class LocalSession implements Session {
	readonly state: SessionState;

	_currentModel: Model<Api>;
	_thinkingState: { level: ThinkingLevel | undefined };
	_llmController: AbortController | undefined;
	private _turnCount = 0;
	private readonly _observers = new Set<(event: AgentEvent) => void>();

	private _agent: Agent = new Agent();
	private _directives: Directives | undefined;
	private readonly _dialog: DialogOrgan;
	private readonly _args: Args;
	private readonly _log: Logger;

	private constructor(
		state: SessionState,
		model: Model<Api>,
		thinkingState: { level: ThinkingLevel | undefined },
		dialog: DialogOrgan,
		args: Args,
		log: Logger,
	) {
		this.state = state;
		this._currentModel = model;
		this._thinkingState = thinkingState;
		this._dialog = dialog;
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
		directives.register({
			id: "tool-shell.boot-catalog",
			priority: 900,
			content: buildBootCatalog(corpusOrgans.flatMap((o) => o.tools)),
			enabled: true,
			tags: ["organ", "dynamic"],
		});

		const directivesBudgetChars = Math.floor(model.contextWindow * 0.1 * 4);
		const thinkingState = {
			level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as
				| ThinkingLevel
				| undefined,
		};

		const dialog = new DialogOrgan({
			sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
		});

		const inst = new LocalSession(
			{ id: store.id, modelId: model.id, contextWindow: model.contextWindow },
			model,
			thinkingState,
			dialog,
			args,
			log,
		);

		const prepareStep = buildPrepareStep(directives, directivesBudgetChars) as unknown as (
			messages: Message[],
		) => Promise<Message[]>;
		const onCheckpoint = buildCheckpointCallback(() => store);

		// toolShell is referenced lazily by llmOrgan.getTools — safe because
		// getTools() is only invoked during LLM turns, after agent.ready().
		// eslint-disable-next-line prefer-const
		let toolShell!: ReturnType<typeof createToolShellOrgan>;

		const dispatch = (event: AgentEvent): void => {
			for (const obs of inst._observers) obs(event);
		};

		const llmOrgan = buildLlmOrgan({
			model,
			cfg,
			args,
			onEvent: dispatch,
			thinkingState,
			prepareStep,
			onCheckpoint,
			getModel: () => inst._currentModel,
			getSignal: () => inst._llmController?.signal,
			getTools: () => toolShell.currentMetaTools(),
		});

		toolShell = createToolShellOrgan({
			tools: corpusOrgans.flatMap((o) => o.tools),
			organDirectives: buildOrganDirectives(corpusOrgans),
		});

		const { agent } = buildAgent({
			dialog,
			llm: llmOrgan,
			session: store,
			modelId: model.id,
			onLoop: (_type, reason) => {
				trace("loop:detected", { reason });
				inst._llmController?.abort(new Error(`[loop-detector] ${reason}`));
			},
		});

		for (const organ of corpusOrgans) agent.load(organ);
		agent.load(toolShell);

		const memoryOrgan = createMemoryOrgan({ sessionStore: () => store, contextWindow: model.contextWindow });
		agent.load(memoryOrgan);
		agent.load(createLlmPipeline([toolShell.phaseStage(), memoryOrgan.phaseStage()]));
		registerOrgans(directives, [toolShell, memoryOrgan]);

		await buildDelegation(args, inst._currentModel, agent, inst, blueprintSurfaces);

		agent.validate();
		await agent.ready();

		inst._agent = agent;
		inst._directives = directives;

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
