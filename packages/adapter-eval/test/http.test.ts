/**
 * Tests for adapter-eval HTTP helpers (collectEvents, postMessage).
 * Spins up a real HTTP server on a random port — no mocks.
 */
import http from "node:http";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvalAdapter } from "../src/adapter.js";
import { collectEvents, postMessage } from "../src/http.js";

adapterComplianceSuite(() => createEvalAdapter({ cwd: process.cwd(), replyEvent: "llm.response" }));

let server: http.Server;
let port: number;

function startServer(handler: http.RequestListener): Promise<void> {
	return new Promise((resolve) => {
		server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			port = (server.address() as { port: number }).port;
			resolve();
		});
	});
}

beforeEach(async () => {
	// Default server — overridden per test if needed
	await startServer((_req, res) => {
		res.writeHead(200);
		res.end();
	});
});

afterEach(() => {
	server.close();
});

describe("postMessage", { tags: ["compliance"] }, () => {
	it("POSTs JSON to /message and resolves on 200", async () => {
		const received: string[] = [];
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			let body = "";
			req.on("data", (c: Buffer) => {
				body += c.toString();
			});
			req.on("end", () => {
				received.push(body);
				res.writeHead(200);
				res.end();
			});
		});

		await postMessage(`http://127.0.0.1:${port}`, "hello eval");
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0]!)).toEqual({ text: "hello eval" });
	});

	it("rejects on connection error", async () => {
		// Use a port that has no listener
		server.close();
		await expect(postMessage(`http://127.0.0.1:${port}`, "x")).rejects.toThrow();
	});
});

describe("collectEvents", { tags: ["compliance"] }, () => {
	it("collects SSE events until isDone returns true", async () => {
		server.removeAllListeners("request");
		server.on("request", (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const frames = [
				{ bus: "command", type: "llm.response", payload: { text: "hello" } },
				{ bus: "command", type: "llm.response", payload: { text: "done" } },
			];
			for (const f of frames) {
				res.write(`data: ${JSON.stringify(f)}\n\n`);
			}
			// keep connection open — isDone will close it
		});

		const events = await collectEvents(`http://127.0.0.1:${port}`, (evts) => evts.length >= 2, 5_000);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ bus: "command", type: "llm.response", text: "hello" });
	});

	it("resolves with partial events on timeout", async () => {
		server.removeAllListeners("request");
		server.on("request", (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ bus: "command", type: "llm.response", payload: { text: "one" } })}\n\n`);
			// sends only 1 event, then stalls
		});

		const events = await collectEvents(
			`http://127.0.0.1:${port}`,
			() => false, // never done
			200, // 200ms timeout
		);
		expect(events).toHaveLength(1);
	});

	it("skips malformed SSE frames silently", async () => {
		server.removeAllListeners("request");
		server.on("request", (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: NOTJSON\n\n");
			res.write(`data: ${JSON.stringify({ bus: "command", type: "llm.response", payload: { text: "ok" } })}\n\n`);
			res.end();
		});

		const events = await collectEvents(
			`http://127.0.0.1:${port}`,
			(evts) => evts.some((e) => e.text === "ok"),
			3_000,
		);
		expect(events.some((e) => e.text === "ok")).toBe(true);
	});
});
