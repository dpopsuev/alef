import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFoundryTextTool } from "../src/evaluations/foundry.js";

async function writeWorkspaceFiles(workspace: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const absolutePath = join(workspace, path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf-8");
	}
}

describe("foundry evaluation checker", { tags: ["unit"] }, () => {
	it("fails when the service wrapper does not use defineAdapterService", async () => {
		if (!createFoundryTextTool.fixture) {
			throw new Error("Foundry_CreateTextTool fixture is required for this test");
		}

		const workspace = await mkdtemp(join(tmpdir(), "alef-foundry-checker-"));
		try {
			await writeWorkspaceFiles(workspace, {
				...createFoundryTextTool.fixture.files,
				"src/service.ts": `
import { createTextAdapter } from "./adapter.js";

export const service = {
	name: "text",
	restart: "permanent",
	shareable: true,
	async create() {
		const adapter = createTextAdapter();
		return {
			name: "text",
			restart: "permanent",
			adapters: [adapter],
			tools: adapter.tools,
			async start() {},
			async stop() {},
			async health() {
				return true;
			},
		};
	},
};
`.trim(),
			});

			const result = await createFoundryTextTool.checker.check({
				workspace,
				spans: [],
				lastReply: "",
			});

			expect(result.pass).toBe(false);
			expect(result.errors.some((error) => error.includes("defineAdapterService"))).toBe(true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
