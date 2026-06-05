/**
 * WebOrgan tests — no real network.
 * Validates organ structure, tool definitions, and error handling.
 * The html-to-text logic is also tested inline with static HTML.
 */

import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebOrgan } from "../src/organ.js";

organComplianceSuite(() => createWebOrgan());

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
		expect(organ.labels).toContain("search");
	});

	it("exposes web.fetch tool", () => {
		const organ = createWebOrgan();
		expect(organ.tools.some((t) => t.name === "web.fetch")).toBe(true);
	});

	it("exposes web.search tool", () => {
		const organ = createWebOrgan();
		expect(organ.tools.some((t) => t.name === "web.search")).toBe(true);
	});

	it("mounts and unmounts cleanly", () => {
		const fixture = new NerveFixture();
		fixture.mount(createWebOrgan());
		fixture.dispose();
	});
});

describe("WebOrgan — web.fetch validation", () => {
	let fixture: NerveFixture;

	beforeEach(() => {
		fixture = new NerveFixture();
		fixture.mount(createWebOrgan());
	});

	afterEach(() => fixture.dispose());

	it("rejects non-http URL", async () => {
		const result = await fixture.call("web.fetch", { url: "ftp://bad-scheme.example.com" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/http/i);
	});

	it("returns isError on network failure", async () => {
		fixture.dispose();
		fixture = new NerveFixture();
		fixture.mount(createWebOrgan({ defaultTimeoutMs: 500 }));
		const result = await fixture.call("web.fetch", { url: "http://127.0.0.1:19999" }, { timeoutMs: 3000 });
		expect(result.isError).toBe(true);
	});
});

describe("WebOrgan — web.search validation", () => {
	let fixture: NerveFixture;

	beforeEach(() => {
		fixture = new NerveFixture();
		fixture.mount(createWebOrgan());
	});

	afterEach(() => fixture.dispose());

	it("rejects empty query", async () => {
		const result = await fixture.call("web.search", { query: "" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/too small|empty|at least|>=1/i);
	});
});

describe("WebOrgan — html-to-text (inline)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("strips tags and returns readable text", async () => {
		const mockHtml = `<html><head><title>Test Page</title></head>
<body><nav>Menu</nav><h1>Hello World</h1><p>This is a paragraph.</p>
<script>alert(1)</script><footer>Footer text</footer></body></html>`;

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 200,
				url: "https://example.com",
				arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
			}),
		);

		const fixture = new NerveFixture();
		fixture.mount(createWebOrgan());
		const result = await fixture.call("web.fetch", { url: "https://example.com" });

		expect(result.payload.title).toBe("Test Page");
		expect(result.payload.statusCode).toBe(200);
		expect(String(result.payload.content)).toContain("Hello World");
		expect(String(result.payload.content)).toContain("This is a paragraph.");
		expect(String(result.payload.content)).not.toContain("alert(1)");
		expect(String(result.payload.content)).not.toContain("Menu");
		expect(String(result.payload.content)).not.toContain("Footer text");
		fixture.dispose();
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

		const fixture = new NerveFixture();
		fixture.mount(createWebOrgan());
		const result = await fixture.call("web.fetch", { url: "https://example.com", format: "html" });
		expect(String(result.payload.content)).toContain("<p>content</p>");
		fixture.dispose();
	});
});
