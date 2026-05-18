/**
 * WebOrgan tests — no real network.
 * Validates organ structure, tool definition, and error handling.
 * The html-to-text logic is also tested inline with static HTML.
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessNerve } from "../../spine/src/buses.js";
import { createWebOrgan } from "../src/organ.js";

describe("WebOrgan — structure", () => {
	it("has name 'web'", () => {
		const organ = createWebOrgan();
		expect(organ.name).toBe("web");
	});

	it("has description and labels", () => {
		const organ = createWebOrgan();
		expect(organ.description).toBeTruthy();
		expect(organ.labels).toContain("web");
		expect(organ.labels).toContain("fetch");
	});

	it("exposes web.fetch tool", () => {
		const organ = createWebOrgan();
		expect(organ.tools.some((t) => t.name === "web.fetch")).toBe(true);
	});

	it("mounts and unmounts cleanly", () => {
		const organ = createWebOrgan();
		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());
		expect(typeof unmount).toBe("function");
		unmount();
	});
});

describe("WebOrgan — web.fetch validation", () => {
	it("rejects non-http URL", async () => {
		const organ = createWebOrgan();
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		const resultPromise = new Promise<{ isError: boolean; errorMessage?: string }>((resolve) => {
			nerve.asNerve().sense.subscribe("web.fetch", (e) => {
				resolve({ isError: e.isError, errorMessage: e.errorMessage });
			});
		});

		nerve.asNerve().motor.publish({
			type: "web.fetch",
			payload: { url: "ftp://bad-scheme.example.com", toolCallId: "t1" },
			correlationId: "c1",
			timestamp: Date.now(),
		});

		const result = await resultPromise;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/http/i);
	});

	it("returns isError on network failure", async () => {
		// Point at a host that won't respond.
		const organ = createWebOrgan({ defaultTimeoutMs: 500 });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		const resultPromise = new Promise<{ isError: boolean }>((resolve) => {
			nerve.asNerve().sense.subscribe("web.fetch", (e) => {
				resolve({ isError: e.isError });
			});
		});

		nerve.asNerve().motor.publish({
			type: "web.fetch",
			payload: { url: "http://127.0.0.1:19999", toolCallId: "t2" },
			correlationId: "c2",
			timestamp: Date.now(),
		});

		const result = await resultPromise;
		expect(result.isError).toBe(true);
	}, 3000);
});

describe("WebOrgan — html-to-text (inline)", () => {
	it("strips tags and returns readable text", async () => {
		// Use the organ's handle via a mocked fetch response.
		const mockHtml = `<html><head><title>Test Page</title></head>
<body><nav>Menu</nav><h1>Hello World</h1><p>This is a paragraph.</p>
<script>alert(1)</script><footer>Footer text</footer></body></html>`;

		const mockFetch = vi.fn().mockResolvedValue({
			status: 200,
			url: "https://example.com",
			arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
		});

		vi.stubGlobal("fetch", mockFetch);

		try {
			const organ = createWebOrgan();
			const nerve = new InProcessNerve();
			organ.mount(nerve.asNerve());

			const resultPromise = new Promise<Record<string, unknown>>((resolve) => {
				nerve.asNerve().sense.subscribe("web.fetch", (e) => {
					resolve(e.payload);
				});
			});

			nerve.asNerve().motor.publish({
				type: "web.fetch",
				payload: { url: "https://example.com", toolCallId: "t3" },
				correlationId: "c3",
				timestamp: Date.now(),
			});

			const result = await resultPromise;
			expect(result.title).toBe("Test Page");
			expect(result.statusCode).toBe(200);
			expect(result.content).toContain("Hello World");
			expect(result.content).toContain("This is a paragraph.");
			// Script and nav/footer content stripped.
			expect(result.content).not.toContain("alert(1)");
			expect(result.content).not.toContain("Menu");
			expect(result.content).not.toContain("Footer text");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("returns raw html when format=html", async () => {
		const mockHtml = "<html><head><title>Raw</title></head><body><p>content</p></body></html>";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 200,
				url: "https://example.com",
				arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
			}),
		);

		try {
			const organ = createWebOrgan();
			const nerve = new InProcessNerve();
			organ.mount(nerve.asNerve());

			const resultPromise = new Promise<Record<string, unknown>>((resolve) => {
				nerve.asNerve().sense.subscribe("web.fetch", (e) => resolve(e.payload));
			});

			nerve.asNerve().motor.publish({
				type: "web.fetch",
				payload: { url: "https://example.com", format: "html", toolCallId: "t4" },
				correlationId: "c4",
				timestamp: Date.now(),
			});

			const result = await resultPromise;
			expect(result.content).toContain("<p>content</p>");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
