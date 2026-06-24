/**
 * RouterAdapter — HTTP/SSE bridge between the Command/Event bus and external processes.
 *
 * Exposes three endpoints:
 *
 * GET /events → text/event-stream — streams every Command and Event bus message
 * POST /message → { "text": "..." } → publishes command/triggerEvent
 * GET /health → { "ok": true, "clients": N }
 *
 * Usage:
 *
 * const router = createRouterAdapter({ port: 3000 });
 * agent.mount(router);
 *
 * The adapter subscribes command/* and event/* wildcards. Every event that crosses
 * the bus is forwarded to all connected SSE clients. External processes can
 * drive the agent by POSTing to /message.
 *
 * CORS headers are set on all responses to allow web UIs served from a
 * different origin to connect directly.
 *
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { EventStream } from "./sse.js";

export interface RouterOptions {
	/** TCP port to listen on. Default: 3000. */
	port?: number;
	/** Host/interface to bind. Default: '127.0.0.1'. */
	host?: string;
	/**
	 * Push-side event allowlist. Only command/event bus messages whose type matches
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
	 * When not provided, the router publishes on command/triggerEvent directly
	 * (ambient agents can set triggerEvent to their own event type).
	 */
	onMessage?: (text: string) => void;
	/**
	 * Command event type published when onMessage is absent.
	 */
	triggerEvent: string;

	/** Returns current session state for GET /state. */
	getState?: () => Record<string, unknown>;
	/** Called on POST /control { model: "..." }. */
	onSetModel?: (id: string) => void;
	/** Called on POST /control { thinking: "..." }. */
	onSetThinking?: (level: string) => void;
	/** Called on POST /cancel to abort the current turn. */
	onCancel?: () => void;
	/** Called on POST /reload { name, path } to hot-reload an adapter. */
	onReloadAdapter?: (name: string, path: string) => Promise<void>;
	/** Returns conversation history for GET /history. */
	getHistory?: () => Record<string, unknown>[];
}

/** Resolved bind address returned by createRouterAdapter().address(). */
export interface RouterAddress {
	host: string;
	port: number;
}

export class RouterAdapter implements Adapter {
	readonly name = "router";
	readonly description =
		"HTTP/SSE bridge: exposes command/event bus messages over GET /events and accepts POST /message.";
	readonly labels = ["http", "sse", "bridge", "observability"] as const;
	readonly tools = [] as const;
	readonly subscriptions = {
		command: ["*"] as const,
		event: ["*"] as const,
		notification: ["*"] as const,
	};
	readonly sources = [] as const;

	private server: Server | null = null;
	private readonly sse = new EventStream();
	private readonly options: {
		port: number;
		host: string;
		allowedEvents: string[];
		triggerEvent: string;
		onMessage?: (text: string) => void;
		getState?: () => Record<string, unknown>;
		onSetModel?: (id: string) => void;
		onSetThinking?: (level: string) => void;
		onCancel?: () => void;
		onReloadAdapter?: (name: string, path: string) => Promise<void>;
		getHistory?: () => Record<string, unknown>[];
	};
	private _readyPromise: Promise<void> | null = null;

	constructor(options: RouterOptions) {
		this.options = {
			port: options.port ?? 3000,
			host: options.host ?? "127.0.0.1",
			allowedEvents: options.allowedEvents ?? [],
			onMessage: options.onMessage,
			triggerEvent: options.triggerEvent,
			getState: options.getState,
			onSetModel: options.onSetModel,
			onSetThinking: options.onSetThinking,
			onCancel: options.onCancel,
			onReloadAdapter: options.onReloadAdapter,
			getHistory: options.getHistory,
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
		if (!this._readyPromise) return Promise.reject(new Error("RouterAdapter not mounted"));
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

	notifyStateChange(state: Record<string, unknown>): void {
		this.sse.broadcastRaw("state", { kind: "state", ...state });
	}

	address(): RouterAddress | null {
		if (!this.server) return null;
		const addr = this.server.address();
		if (!addr || typeof addr === "string") return null;
		return { host: addr.address, port: addr.port };
	}

	mount(bus: Bus): () => void {
		if (this.server) throw new Error("RouterAdapter already mounted");
		// Subscribe wildcards — forward every bus event to SSE clients.
		const off1 = bus.command.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "command",
				type: event.type,
				correlationId: event.correlationId,
				payload: event.payload,
				timestamp: event.timestamp,
			});
		});

		const off2 = bus.event.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "event",
				type: event.type,
				correlationId: event.correlationId,
				payload: event.payload,
				timestamp: event.timestamp,
			});
		});

		const off3 = bus.notification.subscribe("*", (event) => {
			if (!this.isAllowed(event.type)) return;
			this.sse.broadcast({
				bus: "notification",
				type: event.type,
				correlationId: event.correlationId,
				payload: (event as { payload?: Record<string, unknown> }).payload ?? {},
				timestamp: event.timestamp,
			});
		});

		// Start the HTTP server. _ready resolves once the port is bound.
		this.server = createServer((req, res) => this.handle(req, res, bus));
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

	private handle(req: IncomingMessage, res: ServerResponse, bus: Bus): void {
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
			this.handleMessage(req, res, bus);
			return;
		}

		if (req.method === "GET" && url === "/health") {
			this.sendJson(res, 200, { ok: true, clients: this.sse.size });
			return;
		}

		if (req.method === "GET" && url === "/state") {
			this.sendJson(res, 200, this.options.getState?.() ?? {});
			return;
		}

		if (req.method === "GET" && url === "/history") {
			this.sendJson(res, 200, this.options.getHistory?.() ?? []);
			return;
		}

		if (req.method === "POST" && url === "/control") {
			this.handleControl(req, res);
			return;
		}

		if (req.method === "POST" && url === "/cancel") {
			this.options.onCancel?.();
			this.sendJson(res, 202, { ok: true });
			return;
		}

		if (req.method === "POST" && url === "/reload") {
			this.handleReload(req, res);
			return;
		}

		this.sendJson(res, 404, { error: "not found" });
	}

	private handleMessage(req: IncomingMessage, res: ServerResponse, bus: Bus): void {
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
				// the message arrives on the event bus for Reasoner/ScriptedReasoner.
				this.options.onMessage(text);
			} else {
				bus.command.publish({
					type: this.options.triggerEvent,
					payload: { role: "user", text },
					correlationId,
				});
			}

			this.sendJson(res, 202, { ok: true, correlationId });
		});
	}

	private handleControl(req: IncomingMessage, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf-8");
		});
		req.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body) as Record<string, unknown>;
			} catch {
				this.sendJson(res, 400, { error: "invalid JSON" });
				return;
			}

			if (typeof parsed.model === "string") this.options.onSetModel?.(parsed.model);
			if (typeof parsed.thinking === "string") this.options.onSetThinking?.(parsed.thinking);

			this.sendJson(res, 202, { ok: true });
		});
	}

	private handleReload(req: IncomingMessage, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf-8");
		});
		req.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body) as Record<string, unknown>;
			} catch {
				this.sendJson(res, 400, { error: "invalid JSON" });
				return;
			}

			if (typeof parsed.name !== "string" || typeof parsed.path !== "string") {
				this.sendJson(res, 400, { error: 'body must be { "name": string, "path": string }' });
				return;
			}

			if (!this.options.onReloadAdapter) {
				this.sendJson(res, 501, { error: "reload not supported" });
				return;
			}

			this.options
				.onReloadAdapter(parsed.name, parsed.path)
				.then(() => this.sendJson(res, 202, { ok: true }))
				.catch((err: unknown) => this.sendJson(res, 500, { error: String(err) }));
		});
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		const json = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(json);
	}
}

/** Factory — preferred entry point. */
export function createRouterAdapter(options: RouterOptions): RouterAdapter {
	return new RouterAdapter(options);
}
