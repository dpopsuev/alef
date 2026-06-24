/**
 * WebOrgan tests — no real network.
 * Validates adapter structure, tool definitions, and web-spider integration.
 *
 * The hand-rolled HTML→text pipeline has been replaced by web-spider's
 * Readability + Turndown pipeline. Tests verify the contract shape,
 * not the exact text transformation (that's web-spider's responsibility).
 */

import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createWebAdapter());

describe("WebOrgan — structure", { tags: ["compliance"] }, () => {
	it("has name 'web'", () => {
		const organ = createWebAdapter();
		expect(organ.name).toBe("web");
	});

	it("has description and labels", () => {
		const organ = createWebAdapter();
		expect(organ.description).toBeTruthy();
		expect(organ.labels).toContain("web");
		expect(organ.labels).toContain("fetch");
		expect(organ.labels).toContain("search");
	});

	it("exposes web.fetch tool", () => {
		const organ = createWebAdapter();
		expect(organ.tools.some((t) => t.name === "web.fetch")).toBe(true);
	});

	it("exposes web.search tool", () => {
		const organ = createWebAdapter();
		expect(organ.tools.some((t) => t.name === "web.search")).toBe(true);
	});

	it("mounts and unmounts cleanly", () => {
		const fixture = new BusFixture();
		fixture.mount(createWebAdapter());
		fixture.dispose();
	});
});

describe("WebOrgan — web.fetch validation", { tags: ["compliance"] }, () => {
	let fixture: BusFixture;

	beforeEach(() => {
		fixture = new BusFixture();
		fixture.mount(createWebAdapter());
	});

	afterEach(() => fixture.dispose());

	it("rejects non-http URL", async () => {
		const result = await fixture.call("web.fetch", { url: "ftp://bad-scheme.example.com" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/http/i);
	});

	it("returns isError on network failure", async () => {
		fixture.dispose();
		fixture = new BusFixture();
		fixture.mount(createWebAdapter({ defaultTimeoutMs: 500 }));
		const result = await fixture.call("web.fetch", { url: "http://127.0.0.1:19999" }, { timeoutMs: 3000 });
		expect(result.isError).toBe(true);
	});
});

describe("WebOrgan — web.search validation", { tags: ["compliance"] }, () => {
	let fixture: BusFixture;

	beforeEach(() => {
		fixture = new BusFixture();
		fixture.mount(createWebAdapter());
	});

	afterEach(() => fixture.dispose());

	it("rejects empty query", async () => {
		const result = await fixture.call("web.search", { query: "" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/too small|empty|at least|>=1/i);
	});
});

describe("WebOrgan — web.fetch with Readability + Turndown", { tags: ["compliance"] }, () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns content string with article body and title payload field", async () => {
		// Readability needs enough content to recognise an article.
		const mockHtml = `<html>
<head><title>Test Article</title></head>
<body>
  <nav>Site Navigation Menu</nav>
  <article>
    <h1>Hello World</h1>
    <p>This is the article body paragraph with enough words for Readability.</p>
    <p>A second paragraph to ensure sufficient content length for extraction.</p>
  </article>
  <script>alert(1)</script>
  <footer>Footer text copyright 2026</footer>
</body></html>`;

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				url: "https://example.com",
				headers: { get: () => "text/html" },
				text: async () => mockHtml,
				arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
			}),
		);

		const fixture = new BusFixture();
		fixture.mount(createWebAdapter());
		const result = await fixture.call("web.fetch", { url: "https://example.com" });

		// Contract: content is a string the LLM can read
		expect(typeof result.payload.content).toBe("string");
		// Contract: title is extracted
		expect(result.payload.title).toBeTruthy();
		// Contract: article body is in content
		expect(String(result.payload.content)).toContain("Hello World");
		expect(String(result.payload.content)).toContain("article body paragraph");
		// Contract: scripts stripped
		expect(String(result.payload.content)).not.toContain("alert(1)");

		fixture.dispose();
	});

	it("format='html' returns raw HTML in content", async () => {
		const mockHtml = "<html><head><title>Raw</title></head><body><p>raw content</p></body></html>";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				url: "https://example.com",
				headers: { get: () => "text/html" },
				text: async () => mockHtml,
				arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
			}),
		);

		const fixture = new BusFixture();
		fixture.mount(createWebAdapter());
		const result = await fixture.call("web.fetch", { url: "https://example.com", format: "html" });
		expect(String(result.payload.content)).toContain("<p>raw content</p>");
		fixture.dispose();
	});

	it("format='lean' returns metadata without markdown body", async () => {
		const mockHtml = `<html>
<head><title>Lean Article</title></head>
<body>
  <article>
    <h1>Section Heading</h1>
    <p>Enough body text here for Readability to extract the article content properly.</p>
    <p>More content to ensure Readability succeeds with extraction of the article body.</p>
  </article>
</body></html>`;

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				url: "https://example.com",
				headers: { get: () => "text/html" },
				text: async () => mockHtml,
				arrayBuffer: async () => new TextEncoder().encode(mockHtml).buffer,
			}),
		);

		const fixture = new BusFixture();
		fixture.mount(createWebAdapter());
		const result = await fixture.call("web.fetch", { url: "https://example.com", format: "lean" });

		// Lean output is JSON-stringified in content — short, no markdown body
		expect(typeof result.payload.content).toBe("string");
		const parsed = JSON.parse(result.payload.content as string);
		expect(parsed.url).toBe("https://example.com");
		expect(parsed.wordCount).toBeGreaterThan(0);
		// Lean must NOT include the full markdown body
		expect(parsed.markdown).toBeUndefined();

		fixture.dispose();
	});
});
