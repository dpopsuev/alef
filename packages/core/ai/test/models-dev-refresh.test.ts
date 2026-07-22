import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchModelsDev", () => {
	let cacheDir: string;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "alef-models-dev-test-"));
		vi.stubEnv("XDG_CACHE_HOME", cacheDir);
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	it("flattens the provider-keyed models.dev payload into provider/model entries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					anthropic: {
						models: {
							"claude-sonnet-5": { name: "Claude Sonnet 5", reasoning: true, tool_call: true },
							"claude-opus-4-8": { name: "Claude Opus 4.8", reasoning: true, tool_call: true },
						},
					},
					openai: {
						models: {
							"gpt-5": { name: "GPT-5", tool_call: true },
						},
					},
				}),
			),
		);

		const { fetchModelsDev } = await import("../src/models/models-dev.js");
		const entries = await fetchModelsDev();

		expect(entries).toContainEqual(
			expect.objectContaining({ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }),
		);
		expect(entries).toContainEqual(expect.objectContaining({ id: "openai/gpt-5", name: "GPT-5" }));
		expect(entries).toHaveLength(3);
	});

	it("merges flattened entries into the model registry under the correct provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					anthropic: {
						models: {
							"claude-sonnet-5": { name: "Claude Sonnet 5", reasoning: true, tool_call: true },
						},
					},
				}),
			),
		);

		const { fetchModelsDev } = await import("../src/models/models-dev.js");
		const { mergeModelsDevEntries, buildRegistryFromSnapshot } = await import("../src/models/models-snapshot.js");

		const registry = buildRegistryFromSnapshot();
		expect(registry.get("anthropic")?.has("claude-sonnet-5")).toBe(false);

		const entries = await fetchModelsDev();
		mergeModelsDevEntries(registry, entries);

		expect(registry.get("anthropic")?.get("claude-sonnet-5")).toMatchObject({
			id: "claude-sonnet-5",
			provider: "anthropic",
		});
	});

	it("tolerates a malformed top-level payload without throwing", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(["not", "an", "object"])));

		const { fetchModelsDev } = await import("../src/models/models-dev.js");
		await expect(fetchModelsDev()).resolves.toEqual([]);
	});

	it("skips a malformed provider entry but keeps processing the rest", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					broken: "this should be an object with a models map",
					anthropic: { models: { "claude-sonnet-5": { name: "Claude Sonnet 5", tool_call: true } } },
				}),
			),
		);

		const { fetchModelsDev } = await import("../src/models/models-dev.js");
		const entries = await fetchModelsDev();

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "anthropic/claude-sonnet-5" });
	});

	it("skips a malformed model entry but keeps processing the rest", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					anthropic: {
						models: {
							"claude-sonnet-5": { name: "Claude Sonnet 5", tool_call: true },
							"broken-entry": "not an object",
						},
					},
				}),
			),
		);

		const { fetchModelsDev } = await import("../src/models/models-dev.js");
		const entries = await fetchModelsDev();

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "anthropic/claude-sonnet-5" });
	});
});

describe("refreshModelRegistry", () => {
	let cacheDir: string;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "alef-models-dev-test-"));
		vi.stubEnv("XDG_CACHE_HOME", cacheDir);
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	it("coalesces concurrent calls into a single fetch", async () => {
		let resolveFetch!: (value: Response) => void;
		const fetchPromise = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetchMock = vi.fn().mockReturnValue(fetchPromise);
		vi.stubGlobal("fetch", fetchMock);

		const { refreshModelRegistry } = await import("../src/models/llm.js");

		const first = refreshModelRegistry();
		const second = refreshModelRegistry();

		resolveFetch(jsonResponse({ anthropic: { models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } } } }));
		await Promise.all([first, second]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries on the next call after a failed attempt", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);

		const { refreshModelRegistry } = await import("../src/models/llm.js");
		const { getModels } = await import("../src/models/llm-core.js");

		await expect(refreshModelRegistry()).resolves.toBeUndefined();
		expect(getModels("anthropic").some((m) => m.id === "claude-sonnet-5")).toBe(false);

		fetchMock.mockResolvedValueOnce(
			jsonResponse({ anthropic: { models: { "claude-sonnet-5": { name: "Claude Sonnet 5", tool_call: true } } } }),
		);
		await refreshModelRegistry();

		expect(getModels("anthropic").some((m) => m.id === "claude-sonnet-5")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
