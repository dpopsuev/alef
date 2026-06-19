/**
 * RouterOrgan — HTTP/SSE bridge between the Motor/Sense bus and external processes.
 *
 * Exposes three endpoints:
 *
 * GET /events → text/event-stream — streams every Motor and Sense event
 * POST /message → { "text": "..." } → publishes motor/triggerEvent
 * GET /health → { "ok": true, "clients": N }
 *
 * Usage:
 *
 * const router = createRouterOrgan({ port: 3000 });
 * agent.mount(router);
 *
 * The organ subscribes motor/* and sense/* wildcards. Every event that crosses
 * the nerve is forwarded to all connected SSE clients. External processes can
 * drive the agent by POSTing to /message.
 *
 * CORS headers are set on all responses to allow web UIs served from a
 * different origin to connect directly.
 *
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Nerve, Organ } from "@dpopsuev/alef-kernel";
import { SseManager } from "./sse.js";

export interface RouterOptions {
	/** TCP port to listen on. Default: 3000. */
	port?: number;
	/** Host/interface to bind. Default: '127.0.0.1'. */
	host?: string;
	/**
	 * Push-side event allowlist. Only motor/sense events whose type matches
	 * one of these patterns are forwarded to SSE clients.
	 *
	 * Patterns support a single trailing wildcard: 'fs.*' matches 'fs.read',
	 * 'fs.write', etc. The bare '*' matches everything.
	 *
	 * Omit or set to [] to broadcast all events.
	 */
	allowedEvents?: string[];
	/**
	 * Called when POST /message is received with a validated text payload.
	 * Use this to route user messages through the AgentController:
	 * onMessage: (text) => dialog.receive(text, 'user')
	 *
	 * When not provided, the router publishes on motor/triggerEvent directly
	 * (ambient agents can set triggerEvent to their own event type).
	 */
	onMessage?: (text: string) => void;
	/**
	 * Motor event type published when onMessage is absent.
	 */
	triggerEvent: string;
}

/** Resolved bind address returned by createRouterOrgan().address(). */
export interface RouterAddress {
	host: string;
	port: number;
}

export class RouterOrgan implements Organ {
	readonly name = "router";
	readonly description = "HTTP/SSE bridge: exposes motor/sense events over GET /events and accepts POST /message.";
	readonly labels = ["http", "sse", "bridge", "observability"] as const;
	readonly tools = [] as const;
	readonly subscriptions = {
		motor: ["*"] as const,
		sense: ["*"] as const,
		signal: ["*"] as const,
	};
	readonly sources = [] as const;

	private server: Server | null = null;
	private readonly sse = new SseManager();
	private readonly options: Required<Omit<RouterOptions, "allowedEvents" | "onMessage" | "triggerEvent">> & {
		allowedEvents: string[];
		onMessage?: (text: string) => void;
		triggerEvent: string;
	};
	private _readyPromise: Promise<void> | null = null;

	constructor(options: RouterOptions) {
		this.options = {
			port: options.port ?? 3000,
			host: options.host ?? "127.0.0.1",
			allowedEvents: options.allowedEvents ?? [],
			onMessage: options.onMessage,
			triggerEvent: options.triggerEvent,
		};
	}

	/**
	 * Returns true if the given event type should be forwarded to SSE clients.
	 * When allowedEvents is empty, all events pass. Otherwise the type must
	 * match at least one pattern (exact or trailing-wildcard 'prefix.*').
	 */
	private isAllowed(eventType: string): boolean {
		if (this.options.allowedEvents.length === 0) return true;
		for (const pattern of this.options.allowedEvents) {
			if (pattern === "*") return true;
			if (pattern === eventType) return true;
			if (pattern.endsWith(".*") && eventType.startsWith(pattern.slice(0, -1))) return true;
		}
		return false;
	}

	/**
	 * Resolves once the HTTP server is bound and accepting connections.
	 * Await this in tests before making requests.
	 */
	ready(): Promise<void> {
		if (!this._readyPromise) return Promise.reject(new Error("RouterOrgan not mounted"));
		return this._readyPromise;
	}

	/**
	 * Resolved address after ready(). Returns null before mount or after unmount.
	 * Use port=0 in tests to get an OS-assigned port.
	 */
	/**
	 * Forward an AgentEvent to all connected SSE clients.
	 * Framed as { kind: "agent", event } so clients can distinguish from bus events.
	 * Typed as Record<string,unknown> to avoid importing @dpopsuev/alef-session here.
	 */
	notifyAgent(event: Record<string, unknown>): void {
		this.sse.broadcastRaw("agent", { kind: "agent", event });
	}

	address(): RouterAddress | null {
		if (!this.server) return null;
		const addr = this.server.address();
		if (!addr || typeof addr === "string") return null;
		return { host: addr.address, port: addr.port };
	}

	mount(nerve: Nerve): () => void {
		if (this.server) throw new Error("RouterOrgan already mounted");
		// Subscribe wildcards — forward every bus event to SSE clients.
		const off1 = nerve.motor.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "motor",
				type: event.type,
				correlationId: event.correlationId,
				payload: event.payload,
				timestamp: event.timestamp,
			});
		});

		const off2 = nerve.sense.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "sense",
				type: event.type,
				correlationId: event.correlationId,
				payload: event.payload,
				timestamp: event.timestamp,
			});
		});

		const off3 = nerve.signal.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "signal",
				type: event.type,
				correlationId: event.correlationId,
				payload: (event as { payload?: Record<string, unknown> }).payload ?? {},
				timestamp: event.timestamp,
			});
		});

		// Start the HTTP server. _ready resolves once the port is bound.
		this.server = createServer((req, res) => this.handle(req, res, nerve));
		this._readyPromise = new Promise<void>((resolve, reject) => {
			this.server?.once("listening", resolve);
			this.server?.once("error", reject);
		});
		this.server.listen(this.options.port, this.options.host);

		return () => {
			off1();
			off2();
			off3();
			this.sse.closeAll();
			this.server?.close();
			this.server = null;
			this._readyPromise = null;
		};
	}

	// -------------------------------------------------------------------------
	// Request handler
	// -------------------------------------------------------------------------

	private handle(req: IncomingMessage, res: ServerResponse, nerve: Nerve): void {
		// CORS pre-flight.
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = req.url ?? "/";

		if (req.method === "GET" && url === "/events") {
			this.sse.add(res);
			return;
		}

		if (req.method === "POST" && url === "/message") {
			this.handleMessage(req, res, nerve);
			return;
		}

		if (req.method === "GET" && url === "/health") {
			this.sendJson(res, 200, { ok: true, clients: this.sse.size });
			return;
		}

		this.sendJson(res, 404, { error: "not found" });
	}

	private handleMessage(req: IncomingMessage, res: ServerResponse, nerve: Nerve): void {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf-8");
		});
		req.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				this.sendJson(res, 400, { error: "invalid JSON" });
				return;
			}

			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof (parsed as Record<string, unknown>).text !== "string"
			) {
				this.sendJson(res, 400, { error: 'body must be { "text": string }' });
				return;
			}

			const text = (parsed as { text: string }).text;
			const correlationId = randomUUID();

			if (this.options.onMessage) {
				// Route through the AgentController so history is tracked and
				// the message arrives on the sense bus for Reasoner/ScriptedReasoner.
				this.options.onMessage(text);
			} else {
				nerve.motor.publish({
					type: this.options.triggerEvent,
					payload: { role: "user", text },
					correlationId,
				});
			}

			this.sendJson(res, 202, { ok: true, correlationId });
		});
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		const json = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(json);
	}
}

/** Factory — preferred entry point. */
export function createRouterOrgan(options: RouterOptions): RouterOrgan {
	return new RouterOrgan(options);
}
