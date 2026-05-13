import { InMemoryToolResultCache } from "@dpopsuev/alef-organ-fs";
import { describe, expect, it, vi } from "vitest";
import { createFindTool, type FindToolDetails } from "../src/core/tools/find.js";

describe("file_find cache policy", () => {
	it("reuses cached results for identical queries", async () => {
		const glob = vi.fn(async () => ["/workspace/project/src/main.ts"]);
		const tool = createFindTool("/workspace/project", {
			operations: {
				exists: () => true,
				glob,
			},
			cache: new InMemoryToolResultCache({
				ttlMs: 60_000,
				maxEntries: 16,
			}),
		});

		const first = await tool.execute("call-1", {
			pattern: "*.ts",
			path: "src",
			limit: 10,
		});
		const second = await tool.execute("call-2", {
			pattern: "*.ts",
			path: "src",
			limit: 10,
		});

		expect(glob).toHaveBeenCalledTimes(1);
		expect(first.content[0]?.type).toBe("text");
		expect(second.content[0]?.type).toBe("text");
		expect((second.details as FindToolDetails | undefined)?.cache?.hit).toBe(true);
	});
});
