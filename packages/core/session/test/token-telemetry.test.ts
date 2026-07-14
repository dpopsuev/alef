import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";

describe("createTokenTelemetry", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("appends llm.token-usage records with model attribution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "alef-telemetry-"));
		vi.doMock("node:os", async () => {
			const actual = await vi.importActual<typeof import("node:os")>("node:os");
			return { ...actual, homedir: () => dir };
		});

		const { createTokenTelemetry } = await import("../src/token-telemetry.js");
		const bus = new InProcessBus();
		const adapter = createTokenTelemetry("sess-1");
		adapter.mount?.(bus.asBus());

		bus.asBus().notification.publish({
			type: "llm.token-usage",
			payload: {
				usage: {
					input: 10,
					output: 5,
					totalTokens: 15,
					costUsd: 0.01,
					cacheRead: 3,
					modelId: "test-model",
				},
			},
			correlationId: "corr-1",
		});

		// allow async subscriber to flush
		await new Promise((r) => setTimeout(r, 50));

		const raw = await readFile(join(dir, ".alef", "telemetry", "sess-1-tokens.jsonl"), "utf-8");
		const row = JSON.parse(raw.trim()) as {
			sid: string;
			model?: string;
			tokens: { in: number; out: number; cr: number; total: number };
			cost: { total: number };
		};
		expect(row.sid).toBe("sess-1");
		expect(row.model).toBe("test-model");
		expect(row.tokens).toMatchObject({ in: 10, out: 5, cr: 3, total: 15 });
		expect(row.cost.total).toBe(0.01);
	});
});
