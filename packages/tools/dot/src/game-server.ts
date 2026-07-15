/**
 * HTTP Dot game server — separate process plant.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DotWorld, type DotWorldOptions } from "./world.js";

/** Handle returned by startDotGameServer. */
export interface DotGameServer {
	readonly port: number;
	readonly baseUrl: string;
	close(): Promise<void>;
}

/** Read the full request body as utf8. */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

/** Parse optional JSON object from a raw body string. */
function parseObject(raw: string): { seed?: number; dx?: number; dy?: number } {
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected JSON object");
	}
	const seed = "seed" in parsed && typeof parsed.seed === "number" ? parsed.seed : undefined;
	const dx = "dx" in parsed && typeof parsed.dx === "number" ? parsed.dx : undefined;
	const dy = "dy" in parsed && typeof parsed.dy === "number" ? parsed.dy : undefined;
	return { seed, dx, dy };
}

/** Start an HTTP game server (network boundary for the Alef adapter). */
export async function startDotGameServer(opts: DotWorldOptions & { port?: number } = {}): Promise<DotGameServer> {
	const world = new DotWorld(opts);
	world.reset(opts.seed);

	const server: Server = createServer((req, res) => {
		void handle(req, res, world);
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("dot game server: failed to bind TCP port"));
				return;
			}
			resolve(address.port);
		});
	});

	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

/** Route HTTP methods onto DotWorld. */
async function handle(req: IncomingMessage, res: ServerResponse, world: DotWorld): Promise<void> {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	try {
		if (method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { ok: true });
			return;
		}
		if (method === "GET" && url.pathname === "/observe") {
			sendJson(res, 200, world.snapshot());
			return;
		}
		if (method === "POST" && url.pathname === "/reset") {
			const body = parseObject(await readBody(req));
			const seed = typeof body.seed === "number" ? body.seed : undefined;
			sendJson(res, 200, world.reset(seed));
			return;
		}
		if (method === "POST" && url.pathname === "/move") {
			const body = parseObject(await readBody(req));
			const dx = typeof body.dx === "number" ? body.dx : 0;
			const dy = typeof body.dy === "number" ? body.dy : 0;
			sendJson(res, 200, world.move(dx, dy));
			return;
		}
		if (method === "POST" && url.pathname === "/tick") {
			sendJson(res, 200, world.tickDrift());
			return;
		}
		sendJson(res, 404, { error: `unknown ${method} ${url.pathname}` });
	} catch (err) {
		sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
	}
}
