import http from "node:http";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";

function postToChild(endpoint: string, text: string, timeoutMs: number): Promise<void> {
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
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`postToChild timed out after ${timeoutMs}ms`)));
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

function collectReply(endpoint: string, timeoutMs: number): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const url = new URL(`${endpoint}/events`);
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
						const ev = JSON.parse(line.slice(6)) as { bus?: string; type?: string; payload?: { text?: string } };
						if (ev.bus === "motor" && ev.type === "dialog.message" && typeof ev.payload?.text === "string") {
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

export class RemoteProcessStrategy implements ExecutionStrategy {
	constructor(private readonly endpoint: string) {}

	async send(text: string, _sender?: string, timeoutMs = 60_000): Promise<string> {
		const replyPromise = collectReply(this.endpoint, timeoutMs);
		await postToChild(this.endpoint, text, timeoutMs);
		return (await replyPromise) ?? "";
	}
}
