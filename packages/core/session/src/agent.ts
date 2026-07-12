import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";
import type { AgentEvent, Session, SessionState } from "./contracts/session.js";

const DEFAULT_SEND_TIMEOUT_MS = 300_000;

/**
 *
 */
export interface AgentSessionDeps {
	state: SessionState;
	send: (content: string | (TextContent | ImageContent)[], sender: string, timeoutMs?: number) => Promise<string>;
	receive: (content: string | (TextContent | ImageContent)[], sender: string) => void;
	dispose: () => void;
	observers?: Set<(event: AgentEvent) => void>;
}

/**
 *
 */
export class AgentSession implements Session {
	readonly state: SessionState;
	private readonly _observers: Set<(event: AgentEvent) => void>;
	private readonly _deps: AgentSessionDeps;
	private _modelId: string;

	constructor(deps: AgentSessionDeps) {
		this._deps = deps;
		this.state = deps.state;
		this._modelId = deps.state.modelId;
		this._observers = deps.observers ?? new Set();
	}

	getModel(): string {
		return this._modelId;
	}

	setModel(id: string): void {
		this._modelId = id;
	}

	getThinking(): string {
		return "off";
	}

	setThinking(_level: string): void {}

	setTurnController(_ctrl: AbortController | undefined): void {}

	subscribe(observer: (event: AgentEvent) => void): () => void {
		this._observers.add(observer);
		return () => this._observers.delete(observer);
	}

	notify(event: AgentEvent): void {
		for (const obs of this._observers) obs(event);
	}

	async send(content: string | (TextContent | ImageContent)[], timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<string> {
		return this._deps.send(content, "human", timeoutMs);
	}

	receive(content: string | (TextContent | ImageContent)[]): void {
		this._deps.receive(content, "human");
	}

	dispose(): void {
		this._deps.dispose();
	}
}
