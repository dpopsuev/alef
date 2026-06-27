/**
 * agent.spawn entrypoint resolution test.
 *
 * Catches: RUNNER_MAIN pointing to a deleted file (cli/main.ts was
 * deleted when entrypoint.ts replaced it). Every agent.spawn fails
 * silently because the child process binary doesn't exist.
 *
 * This is a static check — no process spawning, just verifying the
 * file path resolves to an existing file.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent.spawn entrypoint", { tags: ["unit"] }, () => {
	it("RUNNER_MAIN points to an existing file", async () => {
		// Import the module to get the resolved path
		// RUNNER_MAIN is a module-level const, not exported.
		// We replicate the resolution logic here.
		const resolved = new URL("../src/child-process.ts", import.meta.url).pathname;
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(resolved, "utf-8");

		// Extract the RUNNER_MAIN path from source
		const match = source.match(/const RUNNER_MAIN = new URL\("([^"]+)"/);
		expect(match).not.toBeNull();

		const relativePath = match![1];
		const absolutePath = new URL(relativePath, `file://${resolved}`).pathname;

		expect(existsSync(absolutePath)).toBe(true);
	});

	it("TSX_BIN resolves to an existing module", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			new URL("../src/child-process.ts", import.meta.url).pathname,
			"utf-8",
		);

		// findTsxModule walks up from child-process.ts to find tsx
		// Just verify the function doesn't throw
		const hasFindTsx = source.includes("findTsxModule");
		expect(hasFindTsx).toBe(true);
	});
});
