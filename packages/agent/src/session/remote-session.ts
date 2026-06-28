import http from "node:http";
import type { AgentEvent, Session, SessionState } from "@dpopsuev/alef-session/contracts";

export interface DaemonEntry {
	port: number;
	host: string;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	token?: string;
}

export class RemoteSession implements Session {
	private readonly host: string;
	private readonly port: number;
	private readonly token: string | undefined;
	private readonly _sessionId: string;
	private readonly observers = new Set<(event: AgentEvent) => void>();
	private sseReq: http.ClientRequest | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	private _modelId = "unknown";
	private _thinking = "off";
	private _contextWindow = 200_000;
	private _stateReady: Promise<void>;
	private _historyReady: Promise<void>;

	constructor(entry: DaemonEntry) {
		this._sessionId = entry.sessionId;
		this.host = entry.host;
		this.port = entry.port;
		this.token = entry.token;
		this._stateReady = this.fetchState();
		this._historyReady = this.fetchHistory();
		this.connectSse();
	}

	get state(): SessionState {
		return {
			id: this._sessionId,
			modelId: this._modelId,
			contextWindow: this._contextWindow,
		};
	}

	async ready(): Promise<void> {
		await Promise.all([this._stateReady, this._historyReady]);
	}

	private fetchState(): Promise<void> {
		return this.getJson("/state")
			.then((data) => {
				if (typeof data.modelId === "string") this._modelId = data.modelId;
				if (typeof data.thinking === "string") this._thinking = data.thinking;
				if (typeof data.contextWindow === "number") this._contextWindow = data.contextWindow;
			})
			.catch((err: unknown) => {
				console.error(`[remote-session] state sync failed: ${String(err)}`);
			});
	}

	private fetchHistory(): Promise<void> {
		return this.getJson("/history")
			.then((data) => {
				if (Array.isArray(data)) {
					for (const event of data) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- HTTP JSON boundary: daemon /history returns AgentEvent[]
						for (const obs of this.observers) obs(event as AgentEvent);
					}
				}
			})
			.catch((err: unknown) => {
				console.error(`[remote-session] history sync failed: ${String(err)}`);
			});
	}

	private scheduleReconnect(): void {
		if (this.disposed) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connectSse();
		}, 1_000);
	}

	private connectSse(): void {
		if (this.disposed) return;
		let buf = "";
		this.sseReq = http.get(`http://${this.host}:${this.port}/events`, (res) => {
			res.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!dataLine) continue;
					try {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SSE JSON boundary
						const parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
						if (parsed.kind === "state") {
							if (typeof parsed.modelId === "string") this._modelId = parsed.modelId;
							if (typeof parsed.thinking === "string") this._thinking = parsed.thinking;
							if (typeof parsed.contextWindow === "number") this._contextWindow = parsed.contextWindow;
							const stateEvent: AgentEvent = {
								type: "state-changed",
								modelId: this._modelId,
								thinking: this._thinking,
								contextWindow: this._contextWindow,
							};
							for (const observer of this.observers) observer(stateEvent);
							continue;
						}
						if (parsed.kind === "agent" && parsed.event) {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SSE JSON boundary: parsed.event is AgentEvent
							for (const observer of this.observers) observer(parsed.event as AgentEvent);
						}
					} catch {
						// malformed frame
					}
				}
			});
			res.on("error", () => this.scheduleReconnect());
			res.on("close", () => this.scheduleReconnect());
		});
		this.sseReq.on("error", () => this.scheduleReconnect());
	}

	subscribe(observer: (event: AgentEvent) => void): () => void {
		this.observers.add(observer);
		return () => this.observers.delete(observer);
	}

	send(text: string, timeoutMs = 300_000): Promise<string> {
		this.receive(text);
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve("");
			}, timeoutMs);
			const unsubscribe = this.subscribe((event) => {
				if (event.type === "token-usage") {
					clearTimeout(timer);
					unsubscribe();
					resolve("");
				}
			});
		});
	}

	receive(text: string): void {
		this.postJson("/message", { text });
	}

	getModel(): string {
		return this._modelId;
	}

	setModel(id: string): void {
		this.postJson("/control", { model: id });
	}

	getThinking(): string {
		return this._thinking;
	}

	setThinking(level: string): void {
		this.postJson("/control", { thinking: level });
	}

	setTurnController(ctrl: AbortController | undefined): void {
		if (ctrl) {
			ctrl.signal.addEventListener(
				"abort",
				() => {
					this.postJson("/cancel", {});
				},
				{ once: true },
			);
		}
	}

	cancelToolCall(callId: string, toolName: string): void {
		this.postJson("/cancel", { callId, toolName });
	}

	reloadAdapter(name: string, path: string): Promise<void> {
		this.postJson("/reload", { name, path });
		return Promise.resolve();
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.sseReq?.destroy();
		this.sseReq = null;
		this.observers.clear();
	}

	private postJson(path: string, body: Record<string, unknown>): void {
		const json = JSON.stringify(body);
		const headers: Record<string, string | number> = {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(json),
		};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		const req = http.request({ hostname: this.host, port: this.port, path, method: "POST", headers }, () => {});
		req.on("error", () => {});
		req.write(json);
		req.end();
	}

	private getJson(path: string): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			http
				.get(`http://${this.host}:${this.port}${path}`, (res) => {
					let body = "";
					res.on("data", (chunk: Buffer) => {
						body += chunk.toString();
					});
					res.on("end", () => {
						try {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- HTTP JSON boundary
							resolve(JSON.parse(body) as Record<string, unknown>);
						} catch {
							reject(new Error("invalid JSON"));
						}
					});
				})
				.on("error", reject);
		});
	}
}
