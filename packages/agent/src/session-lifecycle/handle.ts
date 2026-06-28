/**
 * SessionHandle — thin runtime state wrapper around an assembled agent.
 *
 * Zero adapter imports. Zero assembly code. Owns only:
 *   - turn count and max-turns enforcement
 *   - model and thinking state switches
 *   - abort controller reference
 *   - observer fan-out
 *   - send/receive/subscribe/dispose delegation
 *
 * Created by the assembly factory (local-session.ts) after all adapters are loaded.
 */

import type { Directives } from "@dpopsuev/alef-agent/directives";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import { loadAdapterFromPath } from "@dpopsuev/alef-blueprint/materializer";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import type { AgentController } from "@dpopsuev/alef-engine/controller";
import type { AgentEvent, DirectiveView, Session, SessionState } from "@dpopsuev/alef-session/contracts";
import type { Logger } from "pino";
import type { Args } from "../args.js";

export interface SessionHandleComponents {
	state: SessionState;
	model: Model<Api>;
	thinkingState: { level: ThinkingLevel | undefined };
	controller: AgentController;
	agent: Agent;
	directives: Directives;
	args: Args;
	log: Logger;
	observers: Set<(event: AgentEvent) => void>;
	modelFactory: (id: string) => Model<Api>;
}

export class SessionHandle implements Session {
	readonly state: SessionState;

	_currentModel: Model<Api>;
	_thinkingState: { level: ThinkingLevel | undefined };
	_llmController: AbortController | undefined;
	private _turnCount = 0;
	private readonly _observers: Set<(event: AgentEvent) => void>;
	private readonly _modelFactory: (id: string) => Model<Api>;

	private readonly _agent: Agent;
	private readonly _directives: Directives;
	private readonly _controller: AgentController;
	private readonly _args: Args;
	private readonly _log: Logger;

	constructor({
		state,
		model,
		thinkingState,
		controller,
		agent,
		directives,
		args,
		log,
		observers,
		modelFactory,
	}: SessionHandleComponents) {
		this.state = state;
		this._currentModel = model;
		this._thinkingState = thinkingState;
		this._controller = controller;
		this._agent = agent;
		this._directives = directives;
		this._args = args;
		this._log = log;
		this._observers = observers;
		this._modelFactory = modelFactory;
	}

	getModel(): string {
		return this._currentModel.id;
	}

	setModel(id: string): void {
		this._currentModel = this._modelFactory(id);
		const supportsThinking = this._currentModel.reasoning && !this._currentModel.id.includes("haiku");
		if (!supportsThinking) this._thinkingState.level = undefined;
		else this._thinkingState.level ??= "medium";
		this._notifyStateChanged();
	}

	getThinking(): string {
		return this._thinkingState.level ?? "off";
	}

	setThinking(level: string): void {
		const thinkingLevels: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];
		this._thinkingState.level =
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by includes() check above
			level !== "off" && thinkingLevels.includes(level) ? (level as ThinkingLevel) : undefined;
		this._notifyStateChanged();
	}

	private _notifyStateChanged(): void {
		const event: AgentEvent = {
			type: "state-changed",
			modelId: this._currentModel.id,
			thinking: this._thinkingState.level ?? "off",
			contextWindow: this._currentModel.contextWindow,
		};
		for (const obs of this._observers) obs(event);
	}

	setTurnController(ctrl: AbortController | undefined): void {
		this._llmController = ctrl;
	}

	async loadAdapter(path: string): Promise<void> {
		const adapter = await loadAdapterFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ adapter: n }),
		});
		this._agent.load(adapter);
	}

	unloadAdapter(name: string): boolean {
		return this._agent.unload(name);
	}

	async reloadAdapter(name: string, path: string): Promise<void> {
		const adapter = await loadAdapterFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ adapter: n }),
		});
		this._agent.reload({ ...adapter, name });
	}

	dispose(): void {
		this._agent.dispose();
	}

	send = (text: string, timeoutMs?: number): Promise<string> => {
		if (this._args.maxTurns > 0 && this._turnCount >= this._args.maxTurns) {
			return Promise.reject(
				new Error(`Max turns reached (${this._args.maxTurns}). Start a new session to continue.`),
			);
		}
		this._turnCount++;
		return this._controller.send(text, "human", timeoutMs);
	};

	receive(text: string): void {
		this._controller.receive(text, "user");
	}

	cancelToolCall(callId: string, toolName: string): void {
		this._agent.publishEvent({
			type: toolName,
			correlationId: "*",
			payload: { toolCallId: callId, isFinal: true },
			isError: true,
			errorMessage: "Cancelled by user",
		});
	}

	getDirective(): DirectiveView {
		const d = this._directives;
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
	get adapters() {
		return this._agent.adapters;
	}
}
