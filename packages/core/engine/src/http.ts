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

/** Standard HTTP status code constants used by the router. */
export const HTTP = {
	OK: 200,
	ACCEPTED: 202,
	NO_CONTENT: 204,
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	INTERNAL: 500,
	NOT_IMPLEMENTED: 501,
	UNAVAILABLE: 503,
} as const;

/** Union of all HTTP status codes defined in the HTTP constant. */
export type HttpStatus = (typeof HTTP)[keyof typeof HTTP];

/** Request handler registered on a specific method+path route. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, bus: Bus) => void;

/** Per-route configuration flags for the router. */
export interface RouteOptions {
	protected?: boolean;
}

/** Configuration for the HTTP/SSE router adapter. */
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

/** HTTP/SSE bridge adapter that streams bus events to clients and accepts inbound messages. */
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
	private readonly routes = new Map<string, { handler: RouteHandler; protected: boolean }>();
	private _serviceReady = false;
	private _draining = false;
	private _authToken: string | undefined;
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

		this.addRoute("GET", "/events", (_req, res) => this.sse.add(res));
		this.addRoute("POST", "/message", (req, res, bus) => this.handleMessage(req, res, bus), { protected: true });
		this.addRoute("GET", "/health", (_req, res) => this.sendJson(res, HTTP.OK, { ok: true, clients: this.sse.size }));
		this.addRoute("GET", "/ready", (_req, res) => {
			const status = this._serviceReady ? HTTP.OK : HTTP.UNAVAILABLE;
			this.sendJson(res, status, { ready: this._serviceReady });
		});
		this.addRoute("GET", "/state", (_req, res) => this.sendJson(res, HTTP.OK, this.options.getState?.() ?? {}));
		this.addRoute("GET", "/history", (_req, res) => this.sendJson(res, HTTP.OK, this.options.getHistory?.() ?? []));
		this.addRoute("POST", "/control", (req, res) => this.handleControl(req, res), { protected: true });
		this.addRoute("POST", "/cancel", (_req, res) => {
			this.options.onCancel?.();
			this.sendJson(res, HTTP.ACCEPTED, { ok: true });
		}, { protected: true });
		this.addRoute("POST", "/reload", (req, res) => this.handleReload(req, res), { protected: true });
	}

	addRoute(method: string, path: string, handler: RouteHandler, opts?: RouteOptions): void {
		this.routes.set(`${method} ${path}`, { handler, protected: opts?.protected ?? false });
	}

	setReady(ready = true): void {
		this._serviceReady = ready;
	}

	setDraining(draining = true): void {
		this._draining = draining;
	}

	setAuthToken(token: string): void {
		this._authToken = token;
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
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(HTTP.NO_CONTENT);
			res.end();
			return;
		}

		if (this._draining && req.method === "POST") {
			return this.sendJson(res, HTTP.UNAVAILABLE, { error: "service draining" });
		}

		const route = this.routes.get(`${req.method} ${req.url ?? "/"}`);
		if (!route) return this.sendJson(res, HTTP.NOT_FOUND, { error: "not found" });
		if (route.protected && this._authToken && req.headers.authorization !== `Bearer ${this._authToken}`) {
			return this.sendJson(res, HTTP.UNAUTHORIZED, { error: "unauthorized" });
		}
		route.handler(req, res, bus);
	}

	private readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.on("data", (chunk: Buffer) => { body += chunk.toString("utf-8"); });
			req.on("end", () => {
				try {
					const parsed: unknown = JSON.parse(body);
					if (typeof parsed !== "object" || parsed === null) {
						reject(new Error("invalid JSON"));
						return;
					}
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null check above
					resolve(parsed as Record<string, unknown>);
				} catch {
					reject(new Error("invalid JSON"));
				}
			});
		});
	}

	private handleMessage(req: IncomingMessage, res: ServerResponse, bus: Bus): void {
		this.readJsonBody(req)
			.then((parsed) => {
				if (typeof parsed.text !== "string") {
					return this.sendJson(res, HTTP.BAD_REQUEST, { error: 'body must be { "text": string }' });
				}
				const correlationId = randomUUID();
				if (this.options.onMessage) {
					this.options.onMessage(parsed.text);
				} else {
					bus.command.publish({ type: this.options.triggerEvent, payload: { role: "user", text: parsed.text }, correlationId });
				}
				this.sendJson(res, HTTP.ACCEPTED, { ok: true, correlationId });
			})
			.catch(() => this.sendJson(res, HTTP.BAD_REQUEST, { error: "invalid JSON" }));
	}

	private handleControl(req: IncomingMessage, res: ServerResponse): void {
		this.readJsonBody(req)
			.then((parsed) => {
				if (typeof parsed.model === "string") this.options.onSetModel?.(parsed.model);
				if (typeof parsed.thinking === "string") this.options.onSetThinking?.(parsed.thinking);
				this.sendJson(res, HTTP.ACCEPTED, { ok: true });
			})
			.catch(() => this.sendJson(res, HTTP.BAD_REQUEST, { error: "invalid JSON" }));
	}

	private handleReload(req: IncomingMessage, res: ServerResponse): void {
		this.readJsonBody(req)
			.then((parsed) => {
				if (typeof parsed.name !== "string" || typeof parsed.path !== "string") {
					return this.sendJson(res, HTTP.BAD_REQUEST, { error: 'body must be { "name": string, "path": string }' });
				}
				if (!this.options.onReloadAdapter) {
					return this.sendJson(res, HTTP.NOT_IMPLEMENTED, { error: "reload not supported" });
				}
				this.options.onReloadAdapter(parsed.name, parsed.path)
					.then(() => this.sendJson(res, HTTP.ACCEPTED, { ok: true }))
					.catch((err: unknown) => this.sendJson(res, HTTP.INTERNAL, { error: String(err) }));
			})
			.catch(() => this.sendJson(res, HTTP.BAD_REQUEST, { error: "invalid JSON" }));
	}

	sendText(res: ServerResponse, status: HttpStatus, body: string, contentType = "text/plain"): void {
		res.writeHead(status, { "Content-Type": contentType });
		res.end(body);
	}

	sendJson(res: ServerResponse, status: HttpStatus, body: unknown): void {
		const json = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(json);
	}
}

/** Factory — preferred entry point. */
export function createRouterAdapter(options: RouterOptions): RouterAdapter {
	return new RouterAdapter(options);
}
