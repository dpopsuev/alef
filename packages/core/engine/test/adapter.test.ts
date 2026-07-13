/**
 * RouterAdapter tests.
 *
 * Uses port=0 to get an OS-assigned port, avoiding conflicts in parallel CI.
 * SSE connections are consumed via Node's built-in http.get with response
 * buffering — no fetch/EventSource polyfill needed.
 */

import http from "node:http";

import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createRouterAdapter } from "../src/http.js";

adapterComplianceSuite(() => createRouterAdapter({ port: 0, host: "127.0.0.1", triggerEvent: "llm.input" }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a RouterAdapter on a fresh BusFixture. Returns { adapter, fixture, unmount, baseUrl }. */
async function setup(overrides: { port?: number; host?: string } = {}) {
	const adapter = createRouterAdapter({ port: 0, host: "127.0.0.1", triggerEvent: "llm.input", ...overrides });
	adapter.setReady();
	const fixture = new BusFixture();
	const unmount = fixture.mount(adapter);
	await adapter.ready();
	const addr = adapter.address()!;
	const baseUrl = `http://${addr.host}:${addr.port}`;
	return { adapter, fixture, nerve: fixture.bus, unmount, baseUrl, addr };
}

/** GET a URL and return { status, body }. */
function get(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			})
			.on("error", reject);
	});
}

/** POST JSON to a URL and return { status, body }. */
function post(url: string, payload: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const json = JSON.stringify(payload);
		const parsed = new URL(url);
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: Number(parsed.port),
				path: parsed.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.write(json);
		req.end();
	});
}

/**
 * Connect to SSE endpoint and collect N events, then abort.
 * Returns the parsed BusEvent objects.
 */
function collectSseEvents(url: string, count: number, timeoutMs = 3000): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const events: unknown[] = [];
		const timer = setTimeout(
			() => reject(new Error(`SSE timeout after ${timeoutMs}ms (got ${events.length}/${count})`)),
			timeoutMs,
		);

		http
			.get(url, (res) => {
				let buffer = "";
				res.on("data", (chunk: Buffer) => {
					buffer += chunk.toString("utf-8");
					// Parse SSE frames: each frame ends with \n\n
					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";
					for (const frame of frames) {
						const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
						if (!dataLine) continue;
						try {
							events.push(JSON.parse(dataLine.slice(6)));
						} catch {
							// skip malformed
						}
						if (events.length >= count) {
							clearTimeout(timer);
							res.destroy();
							resolve(events);
							return;
						}
					}
				});
				res.on("error", (err) => {
					// destroyed by us — not an error
					if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") return;
					clearTimeout(timer);
					reject(err);
				});
			})
			.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RouterAdapter — lifecycle", { tags: ["compliance"] }, () => {
	it("address() returns null before mount", async () => {
		const adapter = createRouterAdapter({ triggerEvent: "llm.input" });
		expect(adapter.address()).toBeNull();
	});

	it("address() returns host+port after mount", async () => {
		const { unmount, addr } = await setup();
		expect(addr.host).toBe("127.0.0.1");
		expect(addr.port).toBeGreaterThan(0);
		unmount();
	});

	it("address() returns null after unmount", async () => {
		const { adapter, unmount } = await setup();
		unmount();
		expect(adapter.address()).toBeNull();
	});

	it("subscriptions covers command/* and event/*", async () => {
		const adapter = createRouterAdapter({ triggerEvent: "llm.input" });
		expect(adapter.subscriptions.command).toContain("*");
		expect(adapter.subscriptions.event).toContain("*");
	});
});

describe("RouterAdapter — GET /health", { tags: ["compliance"] }, () => {
	it("returns 200 { ok: true, clients: 0 }", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status, body } = await get(`${baseUrl}/health`);
			expect(status).toBe(200);
			const json = JSON.parse(body);
			expect(json.ok).toBe(true);
			expect(json.clients).toBe(0);
		} finally {
			unmount();
		}
	});
});

describe("RouterAdapter — GET /events (SSE)", { tags: ["compliance"] }, () => {
	it("responds with text/event-stream headers", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			await new Promise<void>((resolve, reject) => {
				http
					.get(`${baseUrl}/events`, (res) => {
						expect(res.headers["content-type"]).toBe("text/event-stream");
						expect(res.headers["cache-control"]).toBe("no-cache");
						res.destroy();
						resolve();
					})
					.on("error", reject);
			});
		} finally {
			unmount();
		}
	});

	it("increments client count while connected", async () => {
		const { adapter, unmount, baseUrl } = await setup();
		try {
			// Connect a client and leave it open long enough to check count.
			await new Promise<void>((resolve, reject) => {
				const req = http.get(`${baseUrl}/events`, async (res) => {
					// Wait one tick for the 'add' to register.
					await new Promise((r) => setTimeout(r, 20));
					expect(adapter.address()).not.toBeNull(); // still mounted
					// Health endpoint reports client count.
					const { body } = await get(`${baseUrl}/health`);
					const json = JSON.parse(body);
					expect(json.clients).toBe(1);
					res.destroy();
					req.destroy();
					resolve();
				});
				req.on("error", (err) => {
					if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
					else reject(err);
				});
			});
		} finally {
			unmount();
		}
	});

	it("streams command events as SSE frames", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			// Prevent dead-letter echo (unhandled commands publish as events)
			nerve.asBus().command.subscribe("test.ping", () => {});

			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));

			nerve.asBus().command.publish({
				type: "test.ping",
				payload: { msg: "hello" },
				correlationId: "c-1",
			});

			const events = await eventsPromise;
			expect(events).toHaveLength(1);
			const evt = events[0] as Record<string, unknown>;
			expect(evt.bus).toBe("command");
			expect(evt.type).toBe("test.ping");
			expect((evt.payload as Record<string, unknown>).msg).toBe("hello");
		} finally {
			unmount();
		}
	});

	it("streams event events as SSE frames", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));

			nerve.asBus().event.publish({
				type: "fs.read",
				payload: { content: "hello world", truncated: false },
				correlationId: "c-2",
				isError: false,
			});

			const events = await eventsPromise;
			const evt = events[0] as Record<string, unknown>;
			expect(evt.bus).toBe("event");
			expect(evt.type).toBe("fs.read");
		} finally {
			unmount();
		}
	});

	it("SSE event name is bus/type", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			// Collect the raw frame text instead of parsed events.
			const framePromise = new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), 3000);
				http
					.get(`${baseUrl}/events`, (res) => {
						let buf = "";
						res.on("data", (chunk: Buffer) => {
							buf += chunk.toString();
							if (buf.includes("event: command/custom.event")) {
								clearTimeout(timer);
								res.destroy();
								resolve(buf);
							}
						});
						res.on("error", (err) => {
							if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") return;
							reject(err);
						});
					})
					.on("error", reject);
			});

			await new Promise((r) => setTimeout(r, 30));
			nerve.asBus().command.publish({ type: "custom.event", payload: {}, correlationId: "c-3" });

			const frame = await framePromise;
			expect(frame).toContain("event: command/custom.event");
		} finally {
			unmount();
		}
	});
});

describe("RouterAdapter — POST /message", { tags: ["compliance"] }, () => {
	it("returns 202 with correlationId", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			// Listen for the dialog.message command event.
			const received: unknown[] = [];
			nerve.asBus().command.subscribe("llm.response", (e) => {
				received.push(e);
			});

			const { status, body } = await post(`${baseUrl}/message`, { text: "hello agent" });
			expect(status).toBe(202);
			const json = JSON.parse(body);
			expect(json.ok).toBe(true);
			expect(typeof json.correlationId).toBe("string");
		} finally {
			unmount();
		}
	});

	it("publishes triggerEvent on command bus", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			const publishedPromise = new Promise<unknown>((resolve) => {
				nerve.asBus().command.subscribe("llm.input", (e) => resolve(e));
			});

			await post(`${baseUrl}/message`, { text: "do something" });

			const event = (await publishedPromise) as Record<string, unknown>;
			expect(event.type).toBe("llm.input");
			const payload = event.payload as Record<string, unknown>;
			expect(payload.role).toBe("user");
			expect(payload.text).toBe("do something");
		} finally {
			unmount();
		}
	});

	it("returns 400 for non-JSON body", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			// post() stringifies everything, so send raw http for invalid JSON
			const raw = await new Promise<{ status: number }>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: Number(new URL(baseUrl).port),
						path: "/message",
						method: "POST",
						headers: { "Content-Type": "application/json" },
					},
					(res) => resolve({ status: res.statusCode ?? 0 }),
				);
				req.on("error", reject);
				req.write("not valid json");
				req.end();
			});
			expect(raw.status).toBe(400);
		} finally {
			unmount();
		}
	});

	it("returns 400 when text field is missing", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status } = await post(`${baseUrl}/message`, { prompt: "wrong field" });
			expect(status).toBe(400);
		} finally {
			unmount();
		}
	});
});

describe("RouterAdapter — unknown routes", { tags: ["compliance"] }, () => {
	it("returns 404 for unknown GET", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status } = await get(`${baseUrl}/unknown`);
			expect(status).toBe(404);
		} finally {
			unmount();
		}
	});
});

describe("RouterAdapter — allowedEvents filter", { tags: ["compliance"] }, () => {
	it("broadcasts all events when allowedEvents is empty (default)", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));
			nerve.asBus().command.publish({ type: "internal.debug", payload: {}, correlationId: "c-1" });
			const events = await eventsPromise;
			expect((events[0] as Record<string, unknown>).type).toBe("internal.debug");
		} finally {
			unmount();
		}
	});

	it("passes events matching an exact allowed type", async () => {
		const adapter = createRouterAdapter({ port: 0, allowedEvents: ["llm.response"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));
			fixture.bus.asBus().command.publish({ type: "llm.response", payload: { text: "hi" }, correlationId: "c-1" });
			const events = await eventsPromise;
			expect((events[0] as Record<string, unknown>).type).toBe("llm.response");
		} finally {
			unmount();
		}
	});

	it("drops events not in the allowedEvents list", async () => {
		const adapter = createRouterAdapter({ port: 0, allowedEvents: ["llm.response"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const collectedFrames: string[] = [];
			const connectedPromise = new Promise<void>((resolve, reject) => {
				http
					.get(`${baseUrl}/events`, (res) => {
						res.on("data", (chunk: Buffer) => {
							collectedFrames.push(chunk.toString());
						});
						res.on("error", (err) => {
							if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED") reject(err);
						});
						setTimeout(() => {
							res.destroy();
							resolve();
						}, 200);
					})
					.on("error", reject);
			});
			await new Promise((r) => setTimeout(r, 30));
			// Publish a blocked event then an allowed event.
			fixture.bus.asBus().command.publish({ type: "loop.detected", payload: {}, correlationId: "c-2" });
			fixture.bus.asBus().command.publish({ type: "llm.response", payload: {}, correlationId: "c-3" });
			await connectedPromise;
			const full = collectedFrames.join("");
			expect(full).not.toContain("loop.detected");
			expect(full).toContain("llm.response");
		} finally {
			unmount();
		}
	});

	it("passes events matching a wildcard pattern (fs.*)", async () => {
		const adapter = createRouterAdapter({ port: 0, allowedEvents: ["fs.*"], triggerEvent: "llm.input" });
		adapter.setReady();
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			// Subscribe no-ops to prevent dead-letter echo doubling frames
			fixture.bus.asBus().command.subscribe("fs.read", () => {});
			fixture.bus.asBus().command.subscribe("fs.write", () => {});

			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 2);
			await new Promise((r) => setTimeout(r, 30));
			fixture.bus.asBus().command.publish({ type: "fs.read", payload: {}, correlationId: "c-1" });
			fixture.bus.asBus().command.publish({ type: "fs.write", payload: {}, correlationId: "c-2" });
			const events = await eventsPromise;
			const types = events.map((e) => (e as Record<string, unknown>).type);
			expect(types).toContain("fs.read");
			expect(types).toContain("fs.write");
		} finally {
			unmount();
		}
	});

	it("drops events not matching wildcard (shell.exec blocked by fs.*)", async () => {
		const adapter = createRouterAdapter({ port: 0, allowedEvents: ["fs.*"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const collectedFrames: string[] = [];
			const connectedPromise = new Promise<void>((resolve, reject) => {
				http
					.get(`${baseUrl}/events`, (res) => {
						res.on("data", (chunk: Buffer) => {
							collectedFrames.push(chunk.toString());
						});
						res.on("error", (err) => {
							if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED") reject(err);
						});
						setTimeout(() => {
							res.destroy();
							resolve();
						}, 200);
					})
					.on("error", reject);
			});
			await new Promise((r) => setTimeout(r, 30));
			fixture.bus.asBus().command.publish({ type: "shell.exec", payload: {}, correlationId: "c-1" });
			fixture.bus.asBus().command.publish({ type: "fs.read", payload: {}, correlationId: "c-2" });
			await connectedPromise;
			const full = collectedFrames.join("");
			expect(full).not.toContain("shell.exec");
			expect(full).toContain("fs.read");
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// GET /state
// ---------------------------------------------------------------------------

describe("RouterAdapter — GET /state", { tags: ["unit"] }, () => {
	it("returns state from getState callback", async () => {
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			getState: () => ({ modelId: "claude-sonnet", thinking: "high", contextWindow: 200_000 }),
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/state`);
			expect(status).toBe(200);
			const json = JSON.parse(body);
			expect(json.modelId).toBe("claude-sonnet");
			expect(json.thinking).toBe("high");
			expect(json.contextWindow).toBe(200_000);
		} finally {
			unmount();
		}
	});

	it("returns empty object when getState is not provided", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status, body } = await get(`${baseUrl}/state`);
			expect(status).toBe(200);
			expect(JSON.parse(body)).toEqual({});
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

describe("RouterAdapter — GET /history", { tags: ["unit"] }, () => {
	it("returns history from getHistory callback", async () => {
		const events = [
			{ type: "chunk", text: "hello" },
			{ type: "turn-complete", reply: "world" },
		];
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			getHistory: () => events,
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/history`);
			expect(status).toBe(200);
			const json = JSON.parse(body);
			expect(json).toHaveLength(2);
			expect(json[0].type).toBe("chunk");
		} finally {
			unmount();
		}
	});

	it("returns empty array when getHistory is not provided", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status, body } = await get(`${baseUrl}/history`);
			expect(status).toBe(200);
			expect(JSON.parse(body)).toEqual([]);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// POST /control
// ---------------------------------------------------------------------------

describe("RouterAdapter — POST /control", { tags: ["unit"] }, () => {
	it("calls onSetModel when model field is present", async () => {
		let receivedModel = "";
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onSetModel: (id) => { receivedModel = id; },
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/control`, { model: "claude-opus" });
			expect(status).toBe(202);
			expect(receivedModel).toBe("claude-opus");
		} finally {
			unmount();
		}
	});

	it("calls onSetThinking when thinking field is present", async () => {
		let receivedThinking = "";
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onSetThinking: (level) => { receivedThinking = level; },
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/control`, { thinking: "high" });
			expect(status).toBe(202);
			expect(receivedThinking).toBe("high");
		} finally {
			unmount();
		}
	});

	it("calls both callbacks when both fields are present", async () => {
		let model = "";
		let thinking = "";
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onSetModel: (id) => { model = id; },
			onSetThinking: (level) => { thinking = level; },
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/control`, { model: "x", thinking: "low" });
			expect(status).toBe(202);
			expect(model).toBe("x");
			expect(thinking).toBe("low");
		} finally {
			unmount();
		}
	});

	it("returns 400 for invalid JSON", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const raw = await new Promise<{ status: number }>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: Number(new URL(baseUrl).port),
						path: "/control",
						method: "POST",
						headers: { "Content-Type": "application/json" },
					},
					(res) => resolve({ status: res.statusCode ?? 0 }),
				);
				req.on("error", reject);
				req.write("not json");
				req.end();
			});
			expect(raw.status).toBe(400);
		} finally {
			unmount();
		}
	});

	it("returns 202 even when callbacks are not provided", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status } = await post(`${baseUrl}/control`, { model: "ignored" });
			expect(status).toBe(202);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// POST /cancel
// ---------------------------------------------------------------------------

describe("RouterAdapter — POST /cancel", { tags: ["unit"] }, () => {
	it("calls onCancel callback", async () => {
		let cancelled = false;
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onCancel: () => { cancelled = true; },
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/cancel`, {});
			expect(status).toBe(202);
			expect(cancelled).toBe(true);
		} finally {
			unmount();
		}
	});

	it("returns 202 when onCancel is not provided", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status } = await post(`${baseUrl}/cancel`, {});
			expect(status).toBe(202);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// POST /reload
// ---------------------------------------------------------------------------

describe("RouterAdapter — POST /reload", { tags: ["unit"] }, () => {
	it("calls onReloadAdapter with name and path", async () => {
		let reloadedName = "";
		let reloadedPath = "";
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onReloadAdapter: async (name, path) => { reloadedName = name; reloadedPath = path; },
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/reload`, { name: "fs", path: "/tmp/fs.ts" });
			expect(status).toBe(202);
			expect(reloadedName).toBe("fs");
			expect(reloadedPath).toBe("/tmp/fs.ts");
		} finally {
			unmount();
		}
	});

	it("returns 400 when name or path is missing", async () => {
		const adapter = createRouterAdapter({
			port: 0,
			triggerEvent: "llm.input",
			onReloadAdapter: async () => {},
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/reload`, { name: "fs" });
			expect(status).toBe(400);
		} finally {
			unmount();
		}
	});

	it("returns 501 when onReloadAdapter is not provided", async () => {
		const { unmount, baseUrl } = await setup();
		try {
			const { status } = await post(`${baseUrl}/reload`, { name: "fs", path: "/tmp/fs.ts" });
			expect(status).toBe(501);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// notifyStateChange
// ---------------------------------------------------------------------------

describe("RouterAdapter — notifyStateChange", { tags: ["unit"] }, () => {
	it("broadcasts state event to SSE clients", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));
			adapter.notifyStateChange({ modelId: "new-model", thinking: "off" });
			const events = await eventsPromise;
			expect(events).toHaveLength(1);
			const evt = events[0] as Record<string, unknown>;
			expect(evt.kind).toBe("state");
			expect(evt.modelId).toBe("new-model");
			expect(evt.thinking).toBe("off");
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// addRoute() — extensibility
// ---------------------------------------------------------------------------

describe("RouterAdapter — addRoute()", { tags: ["unit"] }, () => {
	it("serves a custom GET route", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.addRoute("GET", "/custom", (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("hello from custom");
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/custom`);
			expect(status).toBe(200);
			expect(body).toBe("hello from custom");
		} finally {
			unmount();
		}
	});

	it("overrides a built-in route", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.addRoute("GET", "/health", (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, custom: true }));
		});
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/health`);
			expect(status).toBe(200);
			expect(JSON.parse(body).custom).toBe(true);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// GET /ready — readiness probe
// ---------------------------------------------------------------------------

describe("RouterAdapter — GET /ready", { tags: ["unit"] }, () => {
	it("returns 503 before setReady()", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/ready`);
			expect(status).toBe(503);
			expect(JSON.parse(body).ready).toBe(false);
		} finally {
			unmount();
		}
	});

	it("returns 200 after setReady()", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await get(`${baseUrl}/ready`);
			expect(status).toBe(200);
			expect(JSON.parse(body).ready).toBe(true);
		} finally {
			unmount();
		}
	});

	it("returns 503 after setReady(false)", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		adapter.setReady(false);
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await get(`${baseUrl}/ready`);
			expect(status).toBe(503);
		} finally {
			unmount();
		}
	});

	it("rejects POST during drain", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		adapter.setDraining();
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await post(`${baseUrl}/message`, { text: "hello" });
			expect(status).toBe(503);
			expect(JSON.parse(body).error).toBe("service draining");
		} finally {
			unmount();
		}
	});

	it("allows GET /health during drain", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setDraining();
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await get(`${baseUrl}/health`);
			expect(status).toBe(200);
		} finally {
			unmount();
		}
	});
});

// ---------------------------------------------------------------------------
// setAuthToken() — bearer token auth
// ---------------------------------------------------------------------------

function postWithHeaders(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const json = JSON.stringify(payload);
		const parsed = new URL(url);
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: Number(parsed.port),
				path: parsed.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...headers },
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.write(json);
		req.end();
	});
}

describe("RouterAdapter — auth", { tags: ["unit"] }, () => {
	it("rejects POST /message without token when auth is set", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		adapter.setAuthToken("secret-token");
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status, body } = await postWithHeaders(`${baseUrl}/message`, { text: "hi" });
			expect(status).toBe(401);
			expect(JSON.parse(body).error).toBe("unauthorized");
		} finally {
			unmount();
		}
	});

	it("accepts POST /message with correct token", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		adapter.setAuthToken("secret-token");
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await postWithHeaders(`${baseUrl}/message`, { text: "hi" }, { Authorization: "Bearer secret-token" });
			expect(status).toBe(202);
		} finally {
			unmount();
		}
	});

	it("allows GET /health without token when auth is set", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		adapter.setAuthToken("secret-token");
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await get(`${baseUrl}/health`);
			expect(status).toBe(200);
		} finally {
			unmount();
		}
	});

	it("allows all POST when no auth token set", async () => {
		const adapter = createRouterAdapter({ port: 0, triggerEvent: "llm.input" });
		adapter.setReady();
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const { status } = await post(`${baseUrl}/message`, { text: "hi" });
			expect(status).toBe(202);
		} finally {
			unmount();
		}
	});
});
