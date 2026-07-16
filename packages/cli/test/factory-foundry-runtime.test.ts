import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryAgentStack } from "@dpopsuev/alef-factory-agent";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-factory-foundry-"));
	tempDirs.push(dir);
	return dir;
}

describe("factory profile foundry runtime", { tags: ["unit"] }, () => {
	it("materializes the default factory blueprint through the foundry runtime", async () => {
		const stack = await createFactoryAgentStack({
			cwd: makeTmp(),
			model: { contextWindow: 200_000 } as never,
			subagentFactory: () => ({
				send: async () => "ok",
				dispose: () => {},
			}),
		});

		const adapterNames = stack.adapters.map((adapter) => adapter.name);
		expect(adapterNames).toContain("agent");
		expect(adapterNames).toContain("workflow");
	});
});
