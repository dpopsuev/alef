/**
 * Thin HTTP helpers for talking to a child Alef's RouterOrgan.
 * No external deps — plain node:http only.
 */

import http from "node:http";
import type { TranscriptEvent } from "./types.js";

export function postMessage(endpoint: string, text: string): Promise<void> {
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
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

/**
 * Open SSE stream at /events and collect events until the predicate says
 * we're done or the timeout fires.
 */
export function collectEvents(
	endpoint: string,
	isDone: (events: TranscriptEvent[]) => boolean,
	timeoutMs: number,
): Promise<TranscriptEvent[]> {
	return new Promise((resolve, reject) => {
		const events: TranscriptEvent[] = [];
		let buf = "";
		// lint-ignore: RAWTIMER SSE collection wall-clock deadline
		const timer = setTimeout(() => {
			req.destroy();
			resolve(events);
		}, timeoutMs);

		const url = new URL(`${endpoint}/events`);
		const req = http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname }, (res) => {
			res.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const line = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!line) continue;
					try {
						const raw = JSON.parse(line.slice(6)) as {
							bus?: string;
							type?: string;
							payload?: { text?: string };
						};
						const event: TranscriptEvent = {
							bus: raw.bus ?? "",
							type: raw.type ?? "",
							text: raw.payload?.text,
						};
						events.push(event);
						if (isDone(events)) {
							clearTimeout(timer);
							res.destroy();
							resolve(events);
							return;
						}
					} catch {
						/* skip malformed frames */
					}
				}
			});
			res.on("error", (err) => {
				if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") {
					clearTimeout(timer);
					resolve(events);
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
