/**
 * RouterOrgan tests.
 *
 * Uses port=0 to get an OS-assigned port, avoiding conflicts in parallel CI.
 * SSE connections are consumed via Node's built-in http.get with response
 * buffering — no fetch/EventSource polyfill needed.
 */

import http from "node:http";

import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createRouterOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createRouterOrgan({ port: 0, host: "127.0.0.1", triggerEvent: "llm.input" }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a RouterOrgan on a fresh BusFixture. Returns { adapter, fixture, unmount, baseUrl }. */
async function setup(overrides: { port?: number; host?: string } = {}) {
	const organ = createRouterOrgan({ port: 0, host: "127.0.0.1", triggerEvent: "llm.input", ...overrides });
	const fixture = new BusFixture();
	const unmount = fixture.mount(organ);
	await organ.ready();
	const addr = organ.address()!;
	const baseUrl = `http://${addr.host}:${addr.port}`;
	return { organ, fixture, nerve: fixture.nerve, unmount, baseUrl, addr };
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

describe("RouterOrgan — lifecycle", { tags: ["compliance"] }, () => {
	it("address() returns null before mount", async () => {
		const organ = createRouterOrgan({ triggerEvent: "llm.input" });
		expect(organ.address()).toBeNull();
	});

	it("address() returns host+port after mount", async () => {
		const { unmount, addr } = await setup();
		expect(addr.host).toBe("127.0.0.1");
		expect(addr.port).toBeGreaterThan(0);
		unmount();
	});

	it("address() returns null after unmount", async () => {
		const { organ, unmount } = await setup();
		unmount();
		expect(organ.address()).toBeNull();
	});

	it("subscriptions covers command/* and event/*", async () => {
		const organ = createRouterOrgan({ triggerEvent: "llm.input" });
		expect(organ.subscriptions.command).toContain("*");
		expect(organ.subscriptions.event).toContain("*");
	});
});

describe("RouterOrgan — GET /health", { tags: ["compliance"] }, () => {
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

describe("RouterOrgan — GET /events (SSE)", { tags: ["compliance"] }, () => {
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
		const { organ, unmount, baseUrl } = await setup();
		try {
			// Connect a client and leave it open long enough to check count.
			await new Promise<void>((resolve, reject) => {
				const req = http.get(`${baseUrl}/events`, async (res) => {
					// Wait one tick for the 'add' to register.
					await new Promise((r) => setTimeout(r, 20));
					expect(organ.address()).not.toBeNull(); // still mounted
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
			// Start collecting before we publish.
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);

			// Give the SSE connection time to establish.
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

describe("RouterOrgan — POST /message", { tags: ["compliance"] }, () => {
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

	it("publishes dialog.message on command bus", async () => {
		const { nerve, unmount, baseUrl } = await setup();
		try {
			const publishedPromise = new Promise<unknown>((resolve) => {
				nerve.asBus().command.subscribe("llm.response", (e) => resolve(e));
			});

			await post(`${baseUrl}/message`, { text: "do something" });

			const event = (await publishedPromise) as Record<string, unknown>;
			expect(event.type).toBe("llm.response");
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

describe("RouterOrgan — unknown routes", { tags: ["compliance"] }, () => {
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

describe("RouterOrgan — allowedEvents filter", { tags: ["compliance"] }, () => {
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
		const organ = createRouterOrgan({ port: 0, allowedEvents: ["llm.response"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(organ);
		await organ.ready();
		const baseUrl = `http://${organ.address()!.host}:${organ.address()!.port}`;
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 1);
			await new Promise((r) => setTimeout(r, 30));
			fixture.nerve.asBus().command.publish({ type: "llm.response", payload: { text: "hi" }, correlationId: "c-1" });
			const events = await eventsPromise;
			expect((events[0] as Record<string, unknown>).type).toBe("llm.response");
		} finally {
			unmount();
		}
	});

	it("drops events not in the allowedEvents list", async () => {
		const organ = createRouterOrgan({ port: 0, allowedEvents: ["llm.response"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(organ);
		await organ.ready();
		const baseUrl = `http://${organ.address()!.host}:${organ.address()!.port}`;
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
			fixture.nerve.asBus().command.publish({ type: "loop.detected", payload: {}, correlationId: "c-2" });
			fixture.nerve.asBus().command.publish({ type: "llm.response", payload: {}, correlationId: "c-3" });
			await connectedPromise;
			const full = collectedFrames.join("");
			expect(full).not.toContain("loop.detected");
			expect(full).toContain("llm.response");
		} finally {
			unmount();
		}
	});

	it("passes events matching a wildcard pattern (fs.*)", async () => {
		const adapter = createRouterOrgan({ port: 0, allowedEvents: ["fs.*"], triggerEvent: "llm.input" });
		const fixture = new BusFixture();
		const unmount = fixture.mount(adapter);
		await adapter.ready();
		const baseUrl = `http://${adapter.address()!.host}:${adapter.address()!.port}`;
		try {
			const eventsPromise = collectSseEvents(`${baseUrl}/events`, 2);
			await new Promise((r) => setTimeout(r, 30));
			fixture.nerve.asBus().command.publish({ type: "fs.read", payload: {}, correlationId: "c-1" });
			fixture.nerve.asBus().command.publish({ type: "fs.write", payload: {}, correlationId: "c-2" });
			const events = await eventsPromise;
			const types = events.map((e) => (e as Record<string, unknown>).type);
			expect(types).toContain("fs.read");
			expect(types).toContain("fs.write");
		} finally {
			unmount();
		}
	});

	it("drops events not matching wildcard (shell.exec blocked by fs.*)", async () => {
		const adapter = createRouterOrgan({ port: 0, allowedEvents: ["fs.*"], triggerEvent: "llm.input" });
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
			fixture.nerve.asBus().command.publish({ type: "shell.exec", payload: {}, correlationId: "c-1" });
			fixture.nerve.asBus().command.publish({ type: "fs.read", payload: {}, correlationId: "c-2" });
			await connectedPromise;
			const full = collectedFrames.join("");
			expect(full).not.toContain("shell.exec");
			expect(full).toContain("fs.read");
		} finally {
			unmount();
		}
	});
});
