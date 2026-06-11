/**
 * SessionHandle — thin runtime state wrapper around an assembled agent.
 *
 * Zero organ imports. Zero assembly code. Owns only:
 *   - turn count and max-turns enforcement
 *   - model and thinking state switches
 *   - abort controller reference
 *   - observer fan-out
 *   - send/receive/subscribe/dispose delegation
 *
 * Created by the assembly factory (local-session.ts) after all organs are loaded.
 */

import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Agent } from "@dpopsuev/alef-runtime";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import type { Directives } from "./directives.js";
import { loadOrganFromPath } from "./materializer.js";
import { buildModel } from "./model.js";
import type { AgentEvent, DirectiveView, Session, SessionState } from "./session.js";

export interface SessionHandleComponents {
	state: SessionState;
	model: Model<Api>;
	thinkingState: { level: ThinkingLevel | undefined };
	dialog: DialogOrgan;
	agent: Agent;
	directives: Directives;
	args: Args;
	log: Logger;
}

export class SessionHandle implements Session {
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

	constructor({ state, model, thinkingState, dialog, agent, directives, args, log }: SessionHandleComponents) {
		this.state = state;
		this._currentModel = model;
		this._thinkingState = thinkingState;
		this._dialog = dialog;
		this._agent = agent;
		this._directives = directives;
		this._args = args;
		this._log = log;
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
