/**
 * RemoteSession — Session implementation backed by a running daemon's HTTP/SSE surface.
 *
 * Connects to GET /events to receive AgentEvents forwarded by the daemon.
 * Sends user messages via POST /message.
 * Reads session identity from the daemon registry entry passed at construction.
 */

import http from "node:http";
import type { AgentEvent, Session, SessionState } from "../session.js";

export interface DaemonEntry {
	port: number;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
}

export class RemoteSession implements Session {
	readonly state: SessionState;

	private readonly port: number;
	private readonly observers = new Set<(event: AgentEvent) => void>();
	private sseReq: http.ClientRequest | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(entry: DaemonEntry) {
		this.state = {
			id: entry.sessionId,
			modelId: "remote",
			contextWindow: 200_000,
		};
		this.port = entry.port;
		this.connectSse();
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
		this.sseReq = http.get(`http://127.0.0.1:${this.port}/events`, (res) => {
			res.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!dataLine) continue;
					try {
						const parsed = JSON.parse(dataLine.slice(6)) as {
							kind?: string;
							event?: AgentEvent;
						};
						if (parsed.kind === "agent" && parsed.event) {
							for (const observer of this.observers) observer(parsed.event);
						}
					} catch {
						// malformed frame — skip
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

	receive(text: string): void {
		const body = JSON.stringify({ text });
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: this.port,
				path: "/message",
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
			},
			() => {},
		);
		req.on("error", () => {});
		req.write(body);
		req.end();
	}

	// Remote session cannot control model/thinking/turn on the daemon — no-ops.
	getModel(): string {
		return this.state.modelId;
	}
	setModel(_id: string): void {}
	getThinking(): string {
		return "off";
	}
	setThinking(_level: string): void {}
	setTurnController(_ctrl: AbortController | undefined): void {}

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
}
