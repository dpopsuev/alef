import http from "node:http";
import { Watchdog } from "@dpopsuev/alef-kernel/bus";
import {
	DEFAULT_CONVERSATION_TIMEOUT_MS,
	type ExecutionStrategy,
	type SendRequest,
} from "@dpopsuev/alef-kernel/execution";

/** Send a JSON text payload to a remote agent's /message HTTP endpoint. */
function postMessage(endpoint: string, text: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ text });
		const url = new URL(`${endpoint}/message`);
		const req = http.request(
			{
				hostname: url.hostname,
				port: Number(url.port),
				path: url.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
			},
			(res) => {
				res.resume();
				res.on("end", resolve);
			},
		);
		// lint-ignore: RAWTIMER HTTP request deadline
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`postMessage timed out after ${timeoutMs}ms`)));
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

interface SSEEvent {
	bus?: string;
	type?: string;
	payload?: Record<string, unknown>;
}

/** Listen on the /events SSE stream and resolve with the first matching reply event's text. */
function collectReply(
	endpoint: string,
	timeoutMs: number,
	replyEvent: string,
	onSSEEvent?: (ev: SSEEvent) => void,
): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const url = new URL(`${endpoint}/events`);
		// lint-ignore: RAWTIMER SSE reply wall-clock deadline
		const timer = setTimeout(() => {
			req.destroy();
			resolve(undefined);
		}, timeoutMs);
		const req = http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname }, (res) => {
			res.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const line = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!line) continue;
					try {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, no-magic-numbers -- SSE frame parsed from trusted internal bus
						const ev = JSON.parse(line.slice(6)) as SSEEvent;
						onSSEEvent?.(ev);
						if (ev.bus === "command" && ev.type === replyEvent && typeof ev.payload?.text === "string") {
							clearTimeout(timer);
							res.destroy();
							resolve(ev.payload.text);
							return;
						}
					} catch {
						/* skip malformed */
					}
				}
			});
			res.on("error", (err) => {
				if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") {
					clearTimeout(timer);
					resolve(undefined);
					return;
				}
				clearTimeout(timer);
				reject(err);
			});
		});
		req.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** Configuration for connecting to a remote agent over HTTP/SSE. */
export interface RemoteStrategyOptions {
	endpoint: string;
	replyEvent: string;
	/** Inactivity threshold in ms. When set, the strategy kills itself if no SSE events arrive within this window. */
	stallMs?: number;
	/** Called when stall is detected. Use to kill the child process. */
	onStall?: () => void;
}

/** Sends a prompt to a remote agent via HTTP POST and collects the reply over SSE. */
export class RemoteStrategy implements ExecutionStrategy {
	private readonly endpoint: string;
	private readonly replyEvent: string;
	private readonly stallMs: number | undefined;
	private readonly onStall: (() => void) | undefined;

	constructor(opts: RemoteStrategyOptions) {
		this.endpoint = opts.endpoint;
		this.replyEvent = opts.replyEvent;
		this.stallMs = opts.stallMs;
		this.onStall = opts.onStall;
	}

	/** Send a text prompt to the remote agent and wait for its reply over SSE. */
	async send({
		text,
		timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
		signal,
		onChunk,
		onInnerEvent,
	}: SendRequest): Promise<string> {
		if (signal?.aborted) throw new Error("Aborted before send");

		let watchdog: Watchdog | undefined;
		let stallReject: ((err: Error) => void) | undefined;
		let stallPromise: Promise<never> | undefined;

		let abortPromise: Promise<never> | undefined;
		if (signal) {
			abortPromise = new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
			});
		}

		if (this.stallMs) {
			stallPromise = new Promise<never>((_, reject) => {
				stallReject = reject;
			});
			watchdog = new Watchdog(this.stallMs, () => {
				this.onStall?.();
				stallReject?.(new Error(`Remote strategy stalled — no SSE events for ${this.stallMs}ms`));
			});
			watchdog.start();
		}

		// lint-ignore: RAWTIMER hard wall-clock cap
		const hardTimer = setTimeout(() => {
			watchdog?.stop();
			stallReject?.(new Error(`Remote strategy exceeded maxMs (${timeoutMs}ms)`));
		}, timeoutMs);

		const onSSEEvent = (ev: SSEEvent) => {
			watchdog?.reset();

			if (!ev.type || !ev.payload) return;

			if (onChunk && ev.bus === "notification" && ev.type === "llm.chunk") {
				onChunk(typeof ev.payload.text === "string" ? ev.payload.text : "");
			}
			if (onChunk && ev.bus === "notification" && ev.type === "llm.tool-chunk") {
				onChunk(typeof ev.payload.text === "string" ? ev.payload.text : "");
			}

			if (onInnerEvent && ev.bus === "notification") {
				onInnerEvent("remote", ev.type, ev.payload);
			}
		};

		try {
			const replyPromise = collectReply(this.endpoint, timeoutMs, this.replyEvent, onSSEEvent);
			await postMessage(this.endpoint, text, timeoutMs);
			const promises: Promise<string | undefined>[] = [replyPromise];
			if (stallPromise) promises.push(stallPromise);
			if (abortPromise) promises.push(abortPromise);
			const reply = await Promise.race(promises);
			watchdog?.stop();
			clearTimeout(hardTimer);
			return reply ?? "";
		} catch (err) {
			watchdog?.stop();
			clearTimeout(hardTimer);
			throw err;
		}
	}
}
